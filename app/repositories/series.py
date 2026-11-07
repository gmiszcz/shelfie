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
    keys = set(row.keys())
    pl_raw = (
        json.loads(row["next_expected_pl"])
        if "next_expected_pl" in keys and row["next_expected_pl"]
        else None
    )
    en_raw = (
        json.loads(row["next_expected_en"])
        if "next_expected_en" in keys and row["next_expected_en"]
        else None
    )
    checking = bool(row["checking"]) if "checking" in keys else False
    return SeriesInfo(
        series_key=row["series_key"],
        display_name=row["display_name"] or "",
        author=row["author"] or "",
        aliases=json.loads(row["aliases"] or "[]"),
        known_volumes=[KnownVolume.model_validate(k) for k in known_raw],
        total_known=row["total_known"],
        watch=bool(row["watch"]),
        next_expected=NextExpected.model_validate(next_raw) if next_raw else None,
        next_expected_pl=NextExpected.model_validate(pl_raw) if pl_raw else None,
        next_expected_en=NextExpected.model_validate(en_raw) if en_raw else None,
        checking=checking,
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
    next_pl = (
        json.dumps(info.next_expected_pl.model_dump(), ensure_ascii=False)
        if info.next_expected_pl
        else None
    )
    next_en = (
        json.dumps(info.next_expected_en.model_dump(), ensure_ascii=False)
        if info.next_expected_en
        else None
    )
    last_checked = _now() if touch_checked else info.last_checked
    await conn.execute(
        """
        INSERT INTO series_info
            (user_id, series_key, display_name, author, aliases, known_volumes,
             total_known, watch, next_expected, next_expected_pl, next_expected_en,
             checking, notes, last_checked, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, series_key) DO UPDATE SET
            display_name = excluded.display_name,
            author = excluded.author,
            aliases = excluded.aliases,
            known_volumes = excluded.known_volumes,
            total_known = excluded.total_known,
            watch = excluded.watch,
            next_expected = excluded.next_expected,
            next_expected_pl = excluded.next_expected_pl,
            next_expected_en = excluded.next_expected_en,
            checking = excluded.checking,
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
            next_pl,
            next_en,
            int(info.checking),
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


# --- alert seen-state (series-ux) --------------------------------------------------------


async def seen_alert_keys(conn: aiosqlite.Connection, user_id: int) -> set[str]:
    """Return the set of alert keys this user has already dismissed."""
    cursor = await conn.execute("SELECT alert_key FROM alert_seen WHERE user_id = ?", (user_id,))
    return {row["alert_key"] for row in await cursor.fetchall()}


async def mark_alerts_seen(conn: aiosqlite.Connection, user_id: int, alert_keys: list[str]) -> int:
    """Record ``alert_keys`` as seen for this user (idempotent). Returns rows affected."""
    affected = 0
    for key in alert_keys:
        if not key:
            continue
        cursor = await conn.execute(
            "INSERT INTO alert_seen (user_id, alert_key) VALUES (?, ?) "
            "ON CONFLICT(user_id, alert_key) DO NOTHING",
            (user_id, key),
        )
        affected += cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    await conn.commit()
    return affected


async def prune_seen_alerts(conn: aiosqlite.Connection, user_id: int, keep_keys: set[str]) -> None:
    """Delete seen rows whose alert key is no longer present among current alerts.

    Keeps the table from growing without bound as release dates change (an old key for a
    superseded alert is removed once that alert no longer exists). Never removes a key that
    is still a live alert, so a dismissed-and-still-current alert stays hidden.
    """
    cursor = await conn.execute("SELECT alert_key FROM alert_seen WHERE user_id = ?", (user_id,))
    stored = {row["alert_key"] for row in await cursor.fetchall()}
    stale = stored - keep_keys
    for key in stale:
        await conn.execute(
            "DELETE FROM alert_seen WHERE user_id = ? AND alert_key = ?", (user_id, key)
        )
    if stale:
        await conn.commit()
