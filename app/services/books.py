"""Book business logic. No HTTP, no SQL text — orchestrates repository + integration."""

from __future__ import annotations

import aiosqlite

from app.integrations.google_books import GoogleBooksClient
from app.repositories import books as repo
from app.schemas.books import Book, BookCreate, BookUpdate, SearchResponse


class DuplicateBookError(Exception):
    """A book with the same Google volume id is already in the library."""


async def list_library(conn: aiosqlite.Connection, user_id: int) -> list[Book]:
    return await repo.list_books(conn, user_id)


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


async def search_external(client: GoogleBooksClient, query: str) -> SearchResponse:
    total, items = await client.search(query)
    return SearchResponse(total_items=total, items=items)
