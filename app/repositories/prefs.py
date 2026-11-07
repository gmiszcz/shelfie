"""Persistence for per-user UI preferences (``ui_prefs`` table, series-ux).

A tiny key/value store: one JSON value per (user, pref_key). The frontend keeps a
choice such as the active Series filter here instead of in localStorage, so it is
restored on any device. No business rules — the service layer decides the shape of
each value.
"""

from __future__ import annotations

import json
from typing import Any

import aiosqlite


async def get_pref(
    conn: aiosqlite.Connection, user_id: int, pref_key: str
) -> dict[str, Any] | None:
    """Return the stored JSON object for ``pref_key``, or ``None`` when never set."""
    cursor = await conn.execute(
        "SELECT value FROM ui_prefs WHERE user_id = ? AND pref_key = ?",
        (user_id, pref_key),
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row["value"] or "{}")
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


async def set_pref(
    conn: aiosqlite.Connection, user_id: int, pref_key: str, value: dict[str, Any]
) -> dict[str, Any]:
    """Insert or update the JSON object stored under ``pref_key`` for this user."""
    payload = json.dumps(value, ensure_ascii=False)
    await conn.execute(
        """
        INSERT INTO ui_prefs (user_id, pref_key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, pref_key) DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now')
        """,
        (user_id, pref_key, payload),
    )
    await conn.commit()
    return value
