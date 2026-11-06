"""@tool functions for the library assistant: read-only queries over the local book database.

Tools run synchronously in a worker thread, so they use the stdlib ``sqlite3`` driver against
the same database file the API uses. Every query is parameterised and scoped to the single user.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import date
from typing import Any

from strands import tool

from app.config import get_settings
from app.db import SINGLE_USER_ID
from app.repositories.books import row_to_book
from app.schemas.books import Book
from app.services import stats as stats_service

MAX_LIMIT = 50


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_settings().database_file)
    conn.row_factory = sqlite3.Row
    return conn


def _all_books() -> list[Book]:
    with closing(_connect()) as conn:
        rows = conn.execute("SELECT * FROM books WHERE user_id = ?", (SINGLE_USER_ID,)).fetchall()
    return [row_to_book(row) for row in rows]


def _brief(book: Book) -> dict[str, Any]:
    return {
        "id": book.id,
        "title": book.title,
        "subtitle": book.subtitle,
        "authors": book.authors,
        "series": f"{book.series} #{book.volume}" if book.series and book.volume else book.series,
        "status": book.status.value,
        "stars": book.stars,
        "display_score": book.display_score,
        "finished_on": book.finished_on.isoformat() if book.finished_on else None,
        "shelves": book.shelves,
        "tags": book.tags,
    }


def _limit(value: int) -> int:
    return max(1, min(int(value or 10), MAX_LIMIT))


def _insights_text(book: Book) -> list[str]:
    """Every non-empty string inside a book's insights, for full-text search."""
    if book.insights is None:
        return []
    return [
        value
        for value in book.insights.model_dump().values()
        if isinstance(value, str) and value.strip()
    ]


def _haystack(book: Book) -> str:
    """All searchable text of a book, flattened and lower-cased (accents kept)."""
    parts: list[str] = [
        book.title,
        book.subtitle or "",
        book.series or "",
        book.volume or "",
        book.description or "",
        book.notes or "",
        book.review or "",
        book.quotes or "",
        book.publisher or "",
        book.language or "",
        book.format or "",
        book.edition or "",
        book.status.value,
        *book.authors,
        *book.translators,
        *book.categories,
        *book.shelves,
        *book.tags,
        *_insights_text(book),
    ]
    return " ".join(parts).lower()


@tool
def search_library(query: str, limit: int = 10) -> dict[str, Any]:
    """Search the user's own library by free text, across every text field.

    Matches title, subtitle, authors, translators, series, publisher, language, format,
    edition, categories, shelves, tags, description, notes, review, quotes and the
    generated insights (summary, characters, plot, setting, themes, tone). Case-insensitive,
    accents kept. Use this first whenever the user mentions a book, author, series, a theme,
    a character or anything that might appear in a book's text.

    Args:
        query: Words to look for, e.g. "Droga Szamana", "Sanderson" or "Arlen".
        limit: Maximum number of books to return (1-50).
    """
    needle = query.strip().lower()
    terms = [t for t in needle.split() if t]
    hits: list[Book] = []
    for book in _all_books():
        haystack = _haystack(book)
        if all(term in haystack for term in terms):
            hits.append(book)
    hits.sort(key=lambda b: b.finished_on or date.min, reverse=True)
    return {"count": len(hits), "books": [_brief(b) for b in hits[: _limit(limit)]]}


@tool
def get_book_details(book_id: int) -> dict[str, Any]:
    """Return every stored field for one book (description, notes, dates, purchase data,
    and the generated insights).

    Args:
        book_id: The book id returned by search_library or list_books.
    """
    with closing(_connect()) as conn:
        row = conn.execute(
            "SELECT * FROM books WHERE user_id = ? AND id = ?", (SINGLE_USER_ID, int(book_id))
        ).fetchone()
    if row is None:
        return {"error": f"no book with id {book_id}"}
    return row_to_book(row).model_dump(mode="json")


@tool
def get_book(book_id: int) -> dict[str, Any]:
    """Return every stored field for one book: all catalogue metadata, reading data,
    description, notes, review, quotes and the generated ``insights`` object. Use this
    when the user wants the full detail of a specific book.

    Args:
        book_id: The book id returned by search_library or list_books.
    """
    return get_book_details(book_id)


@tool
def list_books(
    status: str = "",
    shelf: str = "",
    tag: str = "",
    year: int = 0,
    sort_by: str = "finished_on",
    limit: int = 25,
) -> dict[str, Any]:
    """List books from the library with optional filters.

    Args:
        status: One of want, reading, finished, abandoned. Empty for any.
        shelf: Shelf name, e.g. "Fantasy". Empty for any.
        tag: Tag name, e.g. "Magia". Empty for any.
        year: Only books finished in this calendar year. 0 for any year.
        sort_by: "finished_on" (newest first), "stars" (best first) or "title".
        limit: Maximum number of books to return (1-50).
    """
    books = _all_books()
    if status:
        books = [b for b in books if b.status.value == status.strip().lower()]
    if shelf:
        books = [b for b in books if shelf.strip().lower() in (s.lower() for s in b.shelves)]
    if tag:
        books = [b for b in books if tag.strip().lower() in (t.lower() for t in b.tags)]
    if year:
        books = [b for b in books if b.finished_on and b.finished_on.year == int(year)]
    if sort_by == "stars":
        books.sort(key=lambda b: b.display_score or b.stars or 0, reverse=True)
    elif sort_by == "title":
        books.sort(key=lambda b: b.title.lower())
    else:
        books.sort(key=lambda b: b.finished_on or date.min, reverse=True)
    return {"count": len(books), "books": [_brief(b) for b in books[: _limit(limit)]]}


@tool
def reading_stats(date_from: str = "", date_to: str = "", group_by: str = "year") -> dict[str, Any]:
    """Reading statistics for finished books in a date range.

    Args:
        date_from: ISO date (YYYY-MM-DD) or empty for no lower bound.
        date_to: ISO date (YYYY-MM-DD) or empty for no upper bound.
        group_by: "year", "month", "shelf" or "tag".
    """
    try:
        start = date.fromisoformat(date_from) if date_from else None
        end = date.fromisoformat(date_to) if date_to else None
        by = stats_service.GroupBy(group_by)
    except ValueError as exc:
        return {"error": str(exc)}
    result = stats_service.build(_all_books(), start, end, by)
    return {
        "summary": result.summary.model_dump(),
        "groups": [b.model_dump() for b in result.buckets],
    }


@tool
def library_overview() -> dict[str, Any]:
    """Counts of the whole library: totals per status, shelf and tag, and the rated count."""
    books = _all_books()
    by_status: dict[str, int] = {}
    by_shelf: dict[str, int] = {}
    by_tag: dict[str, int] = {}
    for book in books:
        by_status[book.status.value] = by_status.get(book.status.value, 0) + 1
        for shelf in book.shelves:
            by_shelf[shelf] = by_shelf.get(shelf, 0) + 1
        for tag in book.tags:
            by_tag[tag] = by_tag.get(tag, 0) + 1
    return {
        "total": len(books),
        "rated": sum(1 for b in books if b.stars is not None),
        "by_status": by_status,
        "by_shelf": dict(sorted(by_shelf.items(), key=lambda kv: -kv[1])),
        "top_tags": dict(sorted(by_tag.items(), key=lambda kv: -kv[1])[:20]),
    }
