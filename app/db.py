"""Async SQLite access and schema.

Single-file DB via aiosqlite. Every user-owned row carries a ``user_id`` from day one (the
single-user constant for now) so a multi-tenant switch needs no change of shape. The comparison
log is the source of truth for the rating engine; scores on ``books`` are derived from it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import aiosqlite

SINGLE_USER_ID = 1

# Column name -> SQL declaration for the books table. Kept in one place so the schema,
# the migration of older databases and the repository agree on the same column set.
BOOK_COLUMNS: dict[str, str] = {
    "external_id": "TEXT",
    "google_volume_id": "TEXT",
    "title": "TEXT NOT NULL DEFAULT ''",
    "subtitle": "TEXT",
    "authors": "TEXT NOT NULL DEFAULT '[]'",
    "translators": "TEXT NOT NULL DEFAULT '[]'",
    "publisher": "TEXT",
    "published_date": "TEXT",
    "description": "TEXT",
    "page_count": "INTEGER",
    "categories": "TEXT NOT NULL DEFAULT '[]'",
    "language": "TEXT",
    "isbn_10": "TEXT",
    "isbn_13": "TEXT",
    "cover_url": "TEXT",
    "format": "TEXT",
    "edition": "TEXT",
    "series": "TEXT",
    "volume": "TEXT",
    "status": "TEXT NOT NULL DEFAULT 'want'",
    "stars": "REAL",
    "started_on": "TEXT",
    "finished_on": "TEXT",
    "pages_read": "INTEGER",
    "shelves": "TEXT NOT NULL DEFAULT '[]'",
    "tags": "TEXT NOT NULL DEFAULT '[]'",
    "review": "TEXT",
    "notes": "TEXT",
    "quotes": "TEXT",
    "insights": "TEXT",
    "signed": "INTEGER NOT NULL DEFAULT 0",
    "favourite": "INTEGER NOT NULL DEFAULT 0",
    "condition": "TEXT",
    "copies": "INTEGER NOT NULL DEFAULT 1",
    "purchase_date": "TEXT",
    "purchase_price": "REAL",
    "purchase_from": "TEXT",
    "metadata_source": "TEXT NOT NULL DEFAULT 'manual'",
    "latent_strength": "REAL",
    "rating_uncertainty": "REAL",
    "display_score": "REAL",
    "comparison_count": "INTEGER NOT NULL DEFAULT 0",
    "added_at": "TEXT NOT NULL DEFAULT (datetime('now'))",
    "updated_at": "TEXT NOT NULL DEFAULT (datetime('now'))",
}

# Columns stored as JSON arrays.
JSON_LIST_COLUMNS = frozenset({"authors", "translators", "categories", "shelves", "tags"})

# Columns stored as a JSON object (``null`` when absent).
JSON_OBJECT_COLUMNS = frozenset({"insights"})

_BOOK_COLUMNS_SQL = ",\n    ".join(f"{name} {decl}" for name, decl in BOOK_COLUMNS.items())

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE,
    display_name    TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS books (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    {_BOOK_COLUMNS_SQL}
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_volume ON books(user_id, google_volume_id);
CREATE INDEX IF NOT EXISTS idx_books_finished ON books(user_id, finished_on);

CREATE TABLE IF NOT EXISTS comparisons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    session_id    TEXT NOT NULL,
    book_left_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    book_right_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    winner        TEXT NOT NULL CHECK (winner IN ('left', 'right', 'tie')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cached, per-series lookup data for the Series tab (wave 5). One row per
-- (user, normalised series key). ``known_volumes`` / ``next_expected`` /
-- ``aliases`` hold JSON. Reading data stays on ``books``; this table only
-- caches what the external lookups found and the user's watch flag.
CREATE TABLE IF NOT EXISTS series_info (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    series_key    TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    author        TEXT NOT NULL DEFAULT '',
    aliases       TEXT NOT NULL DEFAULT '[]',
    known_volumes TEXT NOT NULL DEFAULT '[]',
    total_known   INTEGER,
    watch         INTEGER NOT NULL DEFAULT 0,
    next_expected TEXT,
    next_expected_pl TEXT,
    next_expected_en TEXT,
    checking      INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    last_checked  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, series_key)
);

CREATE INDEX IF NOT EXISTS idx_series_user ON series_info(user_id);

-- Upcoming / not-yet-owned books the user is waiting for (watched-series next
-- volumes and manual ``add_expected_book`` entries). Separate from ``books``
-- because these are not in the library yet.
CREATE TABLE IF NOT EXISTS expected_books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    title         TEXT NOT NULL DEFAULT '',
    author        TEXT NOT NULL DEFAULT '',
    series_key    TEXT,
    series_name   TEXT,
    volume        TEXT,
    expected_date TEXT,
    source_url    TEXT,
    source        TEXT,
    confidence    TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expected_user ON expected_books(user_id);
"""


async def _migrate(conn: aiosqlite.Connection) -> None:
    """Add columns that a database created by an older version is missing."""
    cursor = await conn.execute("PRAGMA table_info(books)")
    existing = {row[1] for row in await cursor.fetchall()}
    for name, decl in BOOK_COLUMNS.items():
        if name not in existing:
            # SQLite cannot ADD COLUMN with a non-constant default; drop it for added_at-style cols.
            safe_decl = decl.replace("DEFAULT (datetime('now'))", "DEFAULT ''")
            await conn.execute(f"ALTER TABLE books ADD COLUMN {name} {safe_decl}")

    # series_info gained per-language next-expected and a transient "checking" flag in the
    # wave-5 release-research step. Add them to an older cached table (idempotent).
    cursor = await conn.execute("PRAGMA table_info(series_info)")
    series_cols = {row[1] for row in await cursor.fetchall()}
    for name, decl in (
        ("next_expected_pl", "TEXT"),
        ("next_expected_en", "TEXT"),
        ("checking", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if series_cols and name not in series_cols:
            await conn.execute(f"ALTER TABLE series_info ADD COLUMN {name} {decl}")


async def init_db(db_file: Path) -> None:
    """Create the schema (migrating an older one) and seed the single-user row."""
    db_file.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_file) as conn:
        await conn.execute("PRAGMA foreign_keys = ON")
        await conn.executescript(SCHEMA)
        await _migrate(conn)
        await conn.execute(
            "INSERT INTO users (id, display_name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            (SINGLE_USER_ID, "Shelfie User"),
        )
        await conn.commit()


async def reset_library(db_file: Path) -> None:
    """Drop and recreate the library tables (books + comparisons). Users are kept."""
    db_file.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_file) as conn:
        await conn.execute("DROP TABLE IF EXISTS comparisons")
        await conn.execute("DROP TABLE IF EXISTS books")
        await conn.commit()
    await init_db(db_file)


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
