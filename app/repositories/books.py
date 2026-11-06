"""Book data access. Pure persistence — no business rules, no HTTP."""

from __future__ import annotations

import json
from typing import Any

import aiosqlite

from app.schemas.books import Book, BookCreate, BookUpdate


def _row_to_book(row: aiosqlite.Row) -> Book:
    return Book(
        id=row["id"],
        google_volume_id=row["google_volume_id"],
        title=row["title"],
        subtitle=row["subtitle"],
        authors=json.loads(row["authors"]),
        publisher=row["publisher"],
        published_date=row["published_date"],
        description=row["description"],
        page_count=row["page_count"],
        categories=json.loads(row["categories"]),
        language=row["language"],
        isbn_10=row["isbn_10"],
        isbn_13=row["isbn_13"],
        cover_url=row["cover_url"],
        status=row["status"],
        stars=row["stars"],
        added_at=row["added_at"],
        updated_at=row["updated_at"],
    )


async def list_books(conn: aiosqlite.Connection, user_id: int) -> list[Book]:
    cursor = await conn.execute(
        "SELECT * FROM books WHERE user_id = ? ORDER BY added_at DESC",
        (user_id,),
    )
    rows = await cursor.fetchall()
    return [_row_to_book(row) for row in rows]


async def get_book(conn: aiosqlite.Connection, user_id: int, book_id: int) -> Book | None:
    cursor = await conn.execute(
        "SELECT * FROM books WHERE user_id = ? AND id = ?",
        (user_id, book_id),
    )
    row = await cursor.fetchone()
    return _row_to_book(row) if row else None


async def create_book(conn: aiosqlite.Connection, user_id: int, data: BookCreate) -> Book:
    fields: dict[str, Any] = {
        "user_id": user_id,
        "google_volume_id": data.google_volume_id,
        "title": data.title,
        "subtitle": data.subtitle,
        "authors": json.dumps(data.authors),
        "publisher": data.publisher,
        "published_date": data.published_date,
        "description": data.description,
        "page_count": data.page_count,
        "categories": json.dumps(data.categories),
        "language": data.language,
        "isbn_10": data.isbn_10,
        "isbn_13": data.isbn_13,
        "cover_url": data.cover_url,
        "status": data.status.value,
        "stars": data.stars,
    }
    columns = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    cursor = await conn.execute(
        f"INSERT INTO books ({columns}) VALUES ({placeholders})",  # nosec B608 - fixed keys
        tuple(fields.values()),
    )
    await conn.commit()
    book_id = cursor.lastrowid
    if book_id is None:
        raise RuntimeError("INSERT did not return a row id")
    created = await get_book(conn, user_id, book_id)
    if created is None:
        raise RuntimeError("created book could not be read back")
    return created


async def update_book(
    conn: aiosqlite.Connection, user_id: int, book_id: int, data: BookUpdate
) -> Book | None:
    changes = data.model_dump(exclude_unset=True)
    if not changes:
        return await get_book(conn, user_id, book_id)
    sets: list[str] = []
    values: list[Any] = []
    for key, value in changes.items():
        sets.append(f"{key} = ?")
        values.append(value.value if hasattr(value, "value") else value)
    sets.append("updated_at = datetime('now')")
    values.extend([user_id, book_id])
    await conn.execute(
        f"UPDATE books SET {', '.join(sets)} WHERE user_id = ? AND id = ?",  # nosec B608 - fixed keys
        tuple(values),
    )
    await conn.commit()
    return await get_book(conn, user_id, book_id)


async def delete_book(conn: aiosqlite.Connection, user_id: int, book_id: int) -> bool:
    cursor = await conn.execute(
        "DELETE FROM books WHERE user_id = ? AND id = ?",
        (user_id, book_id),
    )
    await conn.commit()
    return cursor.rowcount > 0


async def find_by_volume_id(
    conn: aiosqlite.Connection, user_id: int, volume_id: str
) -> Book | None:
    cursor = await conn.execute(
        "SELECT * FROM books WHERE user_id = ? AND google_volume_id = ?",
        (user_id, volume_id),
    )
    row = await cursor.fetchone()
    return _row_to_book(row) if row else None
