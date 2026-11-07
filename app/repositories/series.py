"""Persistence for series_info and expected_books (wave 5). No business rules."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from app.schemas.series import (
    ExpectedBook,
    ExpectedBookCreate,
    KnownVolume,
    NextExpected,
    SeriesInfo,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_info(row: aiosqlite.Row) -> SeriesInfo:
    known_raw = json.loads(row["known_volumes"] or "[]")
    next_raw = json.loads(row["next_expected"]) if row["next_expected"] else None
    return SeriesInfo(
        series_key=row["series_key"],
        display_name=row["display_name"] or "",
        author=row["author"] or "",
        aliases=json.loads(row["aliases"] or "[]"),
        known_volumes=[KnownVolume.model_validate(k) for k in known_raw],
        total_known=row["total_known"],
        watch=bool(row["watch"]),
        next_expected=NextExpected.model_validate(next_raw) if next_raw else None,
        notes=row["notes"],
        last_checked=row["last_checked"],
    )


async def list_infos(conn: aiosqlite.Connection, user_id: int) -> list[SeriesInfo]:
    cursor = await conn.execute("SELECT * FROM series_info WHERE user_id = ?", (user_id,))
    return [_row_to_info(row) for row in await cursor.fetchall()]


async def get_info(conn: aiosqlite.Connection, user_id: int, series_key: str) -> SeriesInfo | None:
    cursor = await conn.execute(
        "SELECT * FROM series_info WHERE user_id = ? AND series_key = ?",
        (user_id, series_key),
    )
    row = await cursor.fetchone()
    return _row_to_info(row) if row else None


async def upsert_info(
    conn: aiosqlite.Connection,
    user_id: int,
    info: SeriesInfo,
    *,
    touch_checked: bool = False,
) -> SeriesInfo:
    """Insert or update the cached row for a series (keyed by user + series_key)."""
    known = json.dumps([k.model_dump() for k in info.known_volumes], ensure_ascii=False)
    aliases = json.dumps(info.aliases, ensure_ascii=False)
    next_expected = (
        json.dumps(info.next_expected.model_dump(), ensure_ascii=False)
        if info.next_expected
        else None
    )
    last_checked = _now() if touch_checked else info.last_checked
    await conn.execute(
        """
        INSERT INTO series_info
            (user_id, series_key, display_name, author, aliases, known_volumes,
             total_known, watch, next_expected, notes, last_checked, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, series_key) DO UPDATE SET
            display_name = excluded.display_name,
            author = excluded.author,
            aliases = excluded.aliases,
            known_volumes = excluded.known_volumes,
            total_known = excluded.total_known,
            watch = excluded.watch,
            next_expected = excluded.next_expected,
            notes = excluded.notes,
            last_checked = excluded.last_checked,
            updated_at = datetime('now')
        """,
        (
            user_id,
            info.series_key,
            info.display_name,
            info.author,
            aliases,
            known,
            info.total_known,
            int(info.watch),
            next_expected,
            info.notes,
            last_checked,
        ),
    )
    await conn.commit()
    updated = await get_info(conn, user_id, info.series_key)
    if updated is None:
        raise RuntimeError("series_info row could not be read back after upsert")
    return updated


async def set_watch(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    *,
    watch: bool,
    display_name: str = "",
    author: str = "",
) -> SeriesInfo:
    """Toggle the watch flag, creating a bare row if the series was never cached."""
    existing = await get_info(conn, user_id, series_key)
    if existing is None:
        existing = SeriesInfo(
            series_key=series_key, display_name=display_name, author=author, watch=watch
        )
    else:
        existing.watch = watch
    return await upsert_info(conn, user_id, existing)


async def list_watched(conn: aiosqlite.Connection, user_id: int) -> list[SeriesInfo]:
    cursor = await conn.execute(
        "SELECT * FROM series_info WHERE user_id = ? AND watch = 1", (user_id,)
    )
    return [_row_to_info(row) for row in await cursor.fetchall()]


# --- expected_books (waiting list) -------------------------------------------------------


def _row_to_expected(row: aiosqlite.Row) -> ExpectedBook:
    return ExpectedBook(
        id=row["id"],
        title=row["title"],
        author=row["author"] or "",
        series_key=row["series_key"],
        series_name=row["series_name"],
        volume=row["volume"],
        expected_date=row["expected_date"],
        source_url=row["source_url"],
        source=row["source"],
        confidence=row["confidence"],
        notes=row["notes"],
    )


async def list_expected(conn: aiosqlite.Connection, user_id: int) -> list[ExpectedBook]:
    cursor = await conn.execute(
        "SELECT * FROM expected_books WHERE user_id = ? ORDER BY expected_date IS NULL, "
        "expected_date, id",
        (user_id,),
    )
    return [_row_to_expected(row) for row in await cursor.fetchall()]


async def add_expected(
    conn: aiosqlite.Connection,
    user_id: int,
    data: ExpectedBookCreate,
    *,
    series_key: str | None = None,
) -> ExpectedBook:
    cursor = await conn.execute(
        """
        INSERT INTO expected_books
            (user_id, title, author, series_key, series_name, volume, expected_date,
             source_url, source, confidence, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            data.title,
            data.author,
            series_key,
            data.series_name,
            data.volume,
            data.expected_date,
            data.source_url,
            data.source,
            data.confidence,
            data.notes,
        ),
    )
    await conn.commit()
    created = await get_expected(conn, user_id, int(cursor.lastrowid or 0))
    if created is None:
        raise RuntimeError("expected_books row could not be read back after insert")
    return created


async def get_expected(
    conn: aiosqlite.Connection, user_id: int, expected_id: int
) -> ExpectedBook | None:
    cursor = await conn.execute(
        "SELECT * FROM expected_books WHERE user_id = ? AND id = ?", (user_id, expected_id)
    )
    row = await cursor.fetchone()
    return _row_to_expected(row) if row else None


async def update_expected(
    conn: aiosqlite.Connection,
    user_id: int,
    expected_id: int,
    changes: dict[str, Any],
) -> ExpectedBook | None:
    if not changes:
        return await get_expected(conn, user_id, expected_id)
    allowed = {
        "title",
        "author",
        "series_key",
        "series_name",
        "volume",
        "expected_date",
        "source_url",
        "source",
        "confidence",
        "notes",
    }
    sets = [f"{k} = ?" for k in changes if k in allowed]
    if not sets:
        return await get_expected(conn, user_id, expected_id)
    values: list[Any] = [changes[k] for k in changes if k in allowed]
    sets.append("updated_at = datetime('now')")
    values.extend([user_id, expected_id])
    await conn.execute(
        f"UPDATE expected_books SET {', '.join(sets)} WHERE user_id = ? AND id = ?",  # nosec B608
        tuple(values),
    )
    await conn.commit()
    return await get_expected(conn, user_id, expected_id)


async def delete_expected(conn: aiosqlite.Connection, user_id: int, expected_id: int) -> bool:
    cursor = await conn.execute(
        "DELETE FROM expected_books WHERE user_id = ? AND id = ?", (user_id, expected_id)
    )
    await conn.commit()
    return cursor.rowcount > 0


async def find_expected_by_series(
    conn: aiosqlite.Connection, user_id: int, series_key: str
) -> list[ExpectedBook]:
    cursor = await conn.execute(
        "SELECT * FROM expected_books WHERE user_id = ? AND series_key = ?",
        (user_id, series_key),
    )
    return [_row_to_expected(row) for row in await cursor.fetchall()]
