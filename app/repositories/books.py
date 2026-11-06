"""Book data access. Pure persistence — no business rules, no HTTP."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

import aiosqlite

from app.db import BOOK_COLUMNS, JSON_LIST_COLUMNS, JSON_OBJECT_COLUMNS
from app.schemas.books import Book, BookCreate, BookUpdate

# Columns the user supplies (everything except the generated timestamps and derived scores).
_WRITABLE = [c for c in BOOK_COLUMNS if c not in {"added_at", "updated_at"}]


def _to_db(column: str, value: Any) -> Any:
    if column in JSON_LIST_COLUMNS:
        return json.dumps(list(value or []), ensure_ascii=False)
    if column in JSON_OBJECT_COLUMNS:
        return json.dumps(value, ensure_ascii=False) if value is not None else None
    if isinstance(value, date):
        return value.isoformat()
    if hasattr(value, "value"):  # enums
        return value.value
    if isinstance(value, bool):
        return int(value)
    return value


def row_to_book(row: Mapping[str, Any] | sqlite3.Row) -> Book:
    """Map a DB row (aiosqlite or sqlite3) to the Book schema."""
    data: dict[str, Any] = {key: row[key] for key in row.keys()}  # noqa: SIM118 - sqlite3.Row
    for column in JSON_LIST_COLUMNS:
        raw = data.get(column)
        data[column] = json.loads(raw) if raw else []
    for column in JSON_OBJECT_COLUMNS:
        raw = data.get(column)
        data[column] = json.loads(raw) if raw else None
    data["signed"] = bool(data.get("signed"))
    data.pop("user_id", None)
    data["added_at"] = data.get("added_at") or ""
    data["updated_at"] = data.get("updated_at") or ""
    return Book.model_validate(data)


async def list_books(conn: aiosqlite.Connection, user_id: int) -> list[Book]:
    cursor = await conn.execute(
        "SELECT * FROM books WHERE user_id = ? ORDER BY added_at DESC, id DESC",
        (user_id,),
    )
    return [row_to_book(row) for row in await cursor.fetchall()]


async def get_book(conn: aiosqlite.Connection, user_id: int, book_id: int) -> Book | None:
    cursor = await conn.execute(
        "SELECT * FROM books WHERE user_id = ? AND id = ?",
        (user_id, book_id),
    )
    row = await cursor.fetchone()
    return row_to_book(row) if row else None


def _insert_values(user_id: int, data: BookCreate, added_at: str | None) -> tuple[str, tuple]:
    payload = data.model_dump()
    columns = ["user_id"]
    values: list[Any] = [user_id]
    for column in _WRITABLE:
        if column in payload:
            columns.append(column)
            values.append(_to_db(column, payload[column]))
    if added_at:
        columns.append("added_at")
        values.append(added_at)
    sql = (
        f"INSERT INTO books ({', '.join(columns)}) "  # nosec B608 - column names are constants
        f"VALUES ({', '.join('?' for _ in columns)})"
    )
    return sql, tuple(values)


async def create_book(
    conn: aiosqlite.Connection,
    user_id: int,
    data: BookCreate,
    *,
    added_at: str | None = None,
    commit: bool = True,
) -> Book:
    sql, values = _insert_values(user_id, data, added_at)
    cursor = await conn.execute(sql, values)
    if commit:
        await conn.commit()
    book_id = cursor.lastrowid
    if book_id is None:
        raise RuntimeError("INSERT did not return a row id")
    created = await get_book(conn, user_id, book_id)
    if created is None:
        raise RuntimeError("created book could not be read back")
    return created


async def insert_many(
    conn: aiosqlite.Connection,
    user_id: int,
    books: Iterable[tuple[BookCreate, str | None]],
) -> int:
    """Bulk insert ``(book, added_at)`` pairs in one transaction. Returns the row count."""
    count = 0
    for book, added_at in books:
        sql, values = _insert_values(user_id, book, added_at)
        await conn.execute(sql, values)
        count += 1
    await conn.commit()
    return count


async def update_book(
    conn: aiosqlite.Connection, user_id: int, book_id: int, data: BookUpdate
) -> Book | None:
    changes = data.model_dump(exclude_unset=True)
    if not changes:
        return await get_book(conn, user_id, book_id)
    sets: list[str] = []
    values: list[Any] = []
    for column, value in changes.items():
        if column not in BOOK_COLUMNS:
            continue
        if column in JSON_LIST_COLUMNS and value is None:
            value = []
        sets.append(f"{column} = ?")
        values.append(_to_db(column, value))
    sets.append("updated_at = datetime('now')")
    values.extend([user_id, book_id])
    await conn.execute(
        f"UPDATE books SET {', '.join(sets)} WHERE user_id = ? AND id = ?",  # nosec B608 - constant columns
        tuple(values),
    )
    await conn.commit()
    return await get_book(conn, user_id, book_id)


async def set_scores(
    conn: aiosqlite.Connection,
    user_id: int,
    scores: Iterable[tuple[int, float | None, float | None, float | None, int]],
) -> None:
    """Write ``(book_id, latent, uncertainty, display, comparison_count)`` rows."""
    await conn.executemany(
        "UPDATE books SET latent_strength = ?, rating_uncertainty = ?, display_score = ?, "
        "comparison_count = ? WHERE user_id = ? AND id = ?",
        [(lat, unc, disp, cnt, user_id, book_id) for book_id, lat, unc, disp, cnt in scores],
    )
    await conn.commit()


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
    return row_to_book(row) if row else None


# --- comparisons -------------------------------------------------------------------------


async def add_comparison(
    conn: aiosqlite.Connection,
    user_id: int,
    session_id: str,
    left_id: int,
    right_id: int,
    winner: str,
) -> int:
    cursor = await conn.execute(
        "INSERT INTO comparisons (user_id, session_id, book_left_id, book_right_id, winner) "
        "VALUES (?, ?, ?, ?, ?)",
        (user_id, session_id, left_id, right_id, winner),
    )
    await conn.commit()
    return int(cursor.lastrowid or 0)


async def list_comparisons(conn: aiosqlite.Connection, user_id: int) -> list[tuple[int, int, str]]:
    cursor = await conn.execute(
        "SELECT book_left_id, book_right_id, winner FROM comparisons WHERE user_id = ? ORDER BY id",
        (user_id,),
    )
    return [(int(r[0]), int(r[1]), str(r[2])) for r in await cursor.fetchall()]


async def count_comparisons(conn: aiosqlite.Connection, user_id: int) -> int:
    cursor = await conn.execute("SELECT COUNT(*) FROM comparisons WHERE user_id = ?", (user_id,))
    row = await cursor.fetchone()
    return int(row[0]) if row else 0
