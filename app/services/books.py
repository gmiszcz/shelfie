"""Book business logic. No HTTP, no SQL text — orchestrates repository + integration."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import aiosqlite

from app.config import Settings, get_settings
from app.db import connect
from app.integrations.google_books import GoogleBooksClient
from app.repositories import books as repo
from app.schemas.books import Book, BookCreate, BookUpdate, SearchResponse
from app.userdata import UserData, get_current_user_data, using_user_data

logger = logging.getLogger(__name__)

ALLOWED_COVER_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_COVER_BYTES = 5 * 1024 * 1024


class DuplicateBookError(Exception):
    """A book with the same Google volume id is already in the library."""


class CoverError(Exception):
    """An uploaded cover was rejected."""


async def list_library(
    conn: aiosqlite.Connection,
    user_id: int,
    *,
    min_score: float | None = None,
    max_score: float | None = None,
) -> list[Book]:
    return await repo.list_books(conn, user_id, min_score=min_score, max_score=max_score)


async def get(conn: aiosqlite.Connection, user_id: int, book_id: int) -> Book | None:
    return await repo.get_book(conn, user_id, book_id)


async def add_book(conn: aiosqlite.Connection, user_id: int, data: BookCreate) -> Book:
    if data.google_volume_id:
        existing = await repo.find_by_volume_id(conn, user_id, data.google_volume_id)
        if existing is not None:
            raise DuplicateBookError(data.google_volume_id)
    return await repo.create_book(conn, user_id, data)


async def change_book(
    conn: aiosqlite.Connection, user_id: int, book_id: int, data: BookUpdate
) -> Book | None:
    return await repo.update_book(conn, user_id, book_id, data)


async def remove_book(conn: aiosqlite.Connection, user_id: int, book_id: int) -> bool:
    return await repo.delete_book(conn, user_id, book_id)


async def enrich_book(
    user_id: int,
    book_id: int,
    *,
    settings: Settings | None = None,
    user_data: UserData | None = None,
) -> Book | None:
    """Generate insights for one book and persist them. Opens its own connection.

    Safe to run as a detached background task after the request connection is closed. The
    target user's library is resolved from ``user_data`` when given (a background task
    captures it at schedule time), else from the current context var. Any failure (model,
    AWS, parsing) leaves the book's insights unchanged.
    """
    from app.services import enrichment

    settings = settings or get_settings()
    data = user_data or get_current_user_data()
    with using_user_data(data):
        conn = await connect(data.database_file)
        try:
            if not settings.enrichment_enabled:
                logger.info(
                    "enrichment disabled (ENRICHMENT_ENABLED=false); skipping book %s", book_id
                )
                return await repo.get_book(conn, user_id, book_id)
            book = await repo.get_book(conn, user_id, book_id)
            if book is None:
                return None
            insights = await enrichment.generate_insights(book, settings=settings)
            if insights is None:
                logger.info("enrichment produced no insights for book %s", book_id)
                return book
            updated = await repo.update_book(conn, user_id, book_id, BookUpdate(insights=insights))
            return updated
        finally:
            await conn.close()


def schedule_enrichment(background_tasks: object, user_id: int, book_id: int) -> None:
    """Queue ``enrich_book`` on a FastAPI ``BackgroundTasks`` (duck-typed for testability).

    The current user's :class:`UserData` is captured now and handed to the task, so the
    detached run resolves the right per-user library even though it has no request context.
    """
    if not get_settings().enrichment_enabled:
        return
    captured = get_current_user_data()
    add_task = getattr(background_tasks, "add_task", None)
    if callable(add_task):
        add_task(enrich_book, user_id, book_id, user_data=captured)


async def search_external(
    client: GoogleBooksClient, query: str, lang: str | None = None
) -> SearchResponse:
    total, items = await client.search(query, lang=lang)
    return SearchResponse(total_items=total, items=items)


def _sniff_image(data: bytes) -> str | None:
    """Content type from magic bytes — never trust the client's declared type alone."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def save_cover(covers_dir: Path, data: bytes) -> str:
    """Validate and store an uploaded cover. Returns the stored file name."""
    if not data:
        raise CoverError("empty file")
    if len(data) > MAX_COVER_BYTES:
        raise CoverError("cover larger than 5 MB")
    kind = _sniff_image(data)
    if kind is None:
        raise CoverError("only JPEG, PNG or WebP images are accepted")
    covers_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ALLOWED_COVER_TYPES[kind]}"
    (covers_dir / name).write_bytes(data)
    return name
