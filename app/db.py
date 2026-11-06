"""Async SQLite access and schema.

Single file DB via aiosqlite. Every user-owned row carries a ``user_id`` from day one
(set to the single-user constant now) so a multi-tenant switch needs no migration of shape.
The schema stores the raw comparison event log as the source of truth for the rating engine.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import aiosqlite

SINGLE_USER_ID = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE,
    display_name    TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS books (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    google_volume_id  TEXT,
    title             TEXT NOT NULL,
    subtitle          TEXT,
    authors           TEXT NOT NULL DEFAULT '[]',   -- JSON array
    publisher         TEXT,
    published_date    TEXT,
    description        TEXT,
    page_count        INTEGER,
    categories        TEXT NOT NULL DEFAULT '[]',    -- JSON array
    language          TEXT,
    isbn_10           TEXT,
    isbn_13           TEXT,
    cover_url         TEXT,
    status            TEXT NOT NULL DEFAULT 'want',   -- want|reading|finished|abandoned
    stars             REAL,                           -- 1-5 star rating (null = unrated)
    added_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, google_volume_id)
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);

CREATE TABLE IF NOT EXISTS comparisons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    session_id    TEXT NOT NULL,
    book_left_id  INTEGER NOT NULL REFERENCES books(id),
    book_right_id INTEGER NOT NULL REFERENCES books(id),
    winner        TEXT NOT NULL,                      -- left|right|tie
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


async def init_db(db_file: Path) -> None:
    """Create the schema and seed the single-user row."""
    db_file.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_file) as conn:
        await conn.execute("PRAGMA foreign_keys = ON")
        await conn.executescript(SCHEMA)
        await conn.execute(
            "INSERT INTO users (id, display_name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            (SINGLE_USER_ID, "Shelfie User"),
        )
        await conn.commit()


async def connect(db_file: Path) -> aiosqlite.Connection:
    conn = await aiosqlite.connect(db_file)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


async def get_connection(db_file: Path) -> AsyncIterator[aiosqlite.Connection]:
    """FastAPI dependency: one connection per request."""
    conn = await connect(db_file)
    try:
        yield conn
    finally:
        await conn.close()
