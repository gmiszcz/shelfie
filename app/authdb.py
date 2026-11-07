"""The shared auth database: accounts, sessions, setup tokens, login attempts.

``data/auth.sqlite`` is separate from each user's library (``data/users/<id>/shelfie.sqlite``).
It holds no book data — only who may log in, their live sessions and the throttle log. Schema
and the idempotent migration live here; the business rules live in
:mod:`app.services.auth_service`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite

AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    email                TEXT NOT NULL UNIQUE,
    display_name         TEXT NOT NULL DEFAULT '',
    password_hash        TEXT,
    is_admin             INTEGER NOT NULL DEFAULT 0,
    disabled             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    password_changed_at  TEXT
);

CREATE TABLE IF NOT EXISTS auth_identities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent   TEXT,
    ip           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS setup_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL DEFAULT 'setup',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_setup_user ON setup_tokens(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    email   TEXT,
    ip      TEXT,
    at      TEXT NOT NULL DEFAULT (datetime('now')),
    success INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_login_email ON login_attempts(email, at);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, at);
"""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    """Store times as naive UTC ISO strings (SQLite ``datetime('now')`` matches this)."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def parse(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("T", " ")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


@dataclass
class AuthUser:
    """A logged-in account (the subset routes and the context need)."""

    id: int
    email: str
    display_name: str
    is_admin: bool
    disabled: bool = False
    has_password: bool = False
    created_at: str | None = None


def _row_to_user(row: aiosqlite.Row) -> AuthUser:
    return AuthUser(
        id=int(row["id"]),
        email=str(row["email"]),
        display_name=str(row["display_name"] or ""),
        is_admin=bool(row["is_admin"]),
        disabled=bool(row["disabled"]),
        has_password=row["password_hash"] is not None,
        created_at=str(row["created_at"]) if row["created_at"] else None,
    )


async def connect(db_file: Path) -> aiosqlite.Connection:
    conn = await aiosqlite.connect(db_file)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


async def init_auth_db(db_file: Path) -> None:
    """Create the auth schema (idempotent)."""
    db_file.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_file) as conn:
        await conn.executescript(AUTH_SCHEMA)
        await conn.commit()


async def get_auth_connection(db_file: Path) -> AsyncIterator[aiosqlite.Connection]:
    """FastAPI dependency: one auth connection per request."""
    conn = await connect(db_file)
    try:
        yield conn
    finally:
        await conn.close()


# --- users ------------------------------------------------------------------------------


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


async def create_user(
    conn: aiosqlite.Connection,
    *,
    email: str,
    display_name: str,
    is_admin: bool = False,
    user_id: int | None = None,
) -> AuthUser:
    """Insert a user with no password yet. ``user_id`` forces an id (bootstrap uses 1)."""
    email = normalize_email(email)
    if user_id is not None:
        await conn.execute(
            "INSERT INTO users (id, email, display_name, is_admin) VALUES (?, ?, ?, ?)",
            (user_id, email, display_name, int(is_admin)),
        )
        new_id = user_id
    else:
        cursor = await conn.execute(
            "INSERT INTO users (email, display_name, is_admin) VALUES (?, ?, ?)",
            (email, display_name, int(is_admin)),
        )
        new_id = int(cursor.lastrowid or 0)
    await conn.commit()
    user = await get_user(conn, new_id)
    if user is None:  # unreachable in practice; the row was just inserted
        raise RuntimeError("created user could not be read back")
    return user


async def get_user(conn: aiosqlite.Connection, user_id: int) -> AuthUser | None:
    cursor = await conn.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    return _row_to_user(row) if row else None


async def get_user_by_email(conn: aiosqlite.Connection, email: str) -> AuthUser | None:
    cursor = await conn.execute("SELECT * FROM users WHERE email = ?", (normalize_email(email),))
    row = await cursor.fetchone()
    return _row_to_user(row) if row else None


async def get_password_hash(conn: aiosqlite.Connection, user_id: int) -> str | None:
    cursor = await conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    return str(row["password_hash"]) if row and row["password_hash"] is not None else None


async def list_users(conn: aiosqlite.Connection) -> list[AuthUser]:
    cursor = await conn.execute("SELECT * FROM users ORDER BY id")
    return [_row_to_user(row) for row in await cursor.fetchall()]


async def count_active_admins(conn: aiosqlite.Connection) -> int:
    cursor = await conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND disabled = 0")
    row = await cursor.fetchone()
    return int(row[0]) if row else 0


async def set_password(conn: aiosqlite.Connection, user_id: int, password_hash: str) -> None:
    await conn.execute(
        "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
        (password_hash, iso(utcnow()), user_id),
    )
    await conn.commit()


async def update_user(
    conn: aiosqlite.Connection,
    user_id: int,
    *,
    display_name: str | None = None,
    disabled: bool | None = None,
    is_admin: bool | None = None,
) -> AuthUser | None:
    sets: list[str] = []
    values: list[Any] = []
    if display_name is not None:
        sets.append("display_name = ?")
        values.append(display_name)
    if disabled is not None:
        sets.append("disabled = ?")
        values.append(int(disabled))
    if is_admin is not None:
        sets.append("is_admin = ?")
        values.append(int(is_admin))
    if sets:
        values.append(user_id)
        await conn.execute(
            f"UPDATE users SET {', '.join(sets)} WHERE id = ?",  # nosec B608 - constant columns
            tuple(values),
        )
        await conn.commit()
    return await get_user(conn, user_id)


# --- sessions ---------------------------------------------------------------------------


@dataclass
class SessionRow:
    id: int
    user_id: int
    expires_at: datetime
    last_seen_at: datetime


async def create_session(
    conn: aiosqlite.Connection,
    *,
    token_hash: str,
    user_id: int,
    expires_at: datetime,
    user_agent: str | None,
    ip: str | None,
) -> int:
    cursor = await conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) "
        "VALUES (?, ?, ?, ?, ?)",
        (token_hash, user_id, iso(expires_at), user_agent, ip),
    )
    await conn.commit()
    return int(cursor.lastrowid or 0)


async def get_session_by_token_hash(
    conn: aiosqlite.Connection, token_hash: str
) -> SessionRow | None:
    cursor = await conn.execute(
        "SELECT id, user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?",
        (token_hash,),
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    expires = parse(row["expires_at"])
    last_seen = parse(row["last_seen_at"]) or utcnow()
    if expires is None:
        return None
    return SessionRow(
        id=int(row["id"]), user_id=int(row["user_id"]), expires_at=expires, last_seen_at=last_seen
    )


async def touch_session(
    conn: aiosqlite.Connection, session_id: int, *, expires_at: datetime | None = None
) -> None:
    if expires_at is not None:
        await conn.execute(
            "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
            (iso(utcnow()), iso(expires_at), session_id),
        )
    else:
        await conn.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
            (iso(utcnow()), session_id),
        )
    await conn.commit()


async def delete_session(conn: aiosqlite.Connection, session_id: int) -> None:
    await conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    await conn.commit()


async def delete_sessions_for_user(
    conn: aiosqlite.Connection, user_id: int, *, except_session_id: int | None = None
) -> int:
    if except_session_id is not None:
        cursor = await conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND id != ?", (user_id, except_session_id)
        )
    else:
        cursor = await conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    await conn.commit()
    return cursor.rowcount


async def delete_expired_sessions(conn: aiosqlite.Connection) -> int:
    cursor = await conn.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(utcnow()),))
    await conn.commit()
    return cursor.rowcount


# --- setup / reset tokens ---------------------------------------------------------------


@dataclass
class SetupTokenRow:
    id: int
    user_id: int
    purpose: str
    expires_at: datetime
    used_at: datetime | None


async def invalidate_user_setup_tokens(conn: aiosqlite.Connection, user_id: int) -> None:
    """Mark every unused setup/reset token of a user as used (a new link invalidates old)."""
    await conn.execute(
        "UPDATE setup_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
        (iso(utcnow()), user_id),
    )
    await conn.commit()


async def create_setup_token(
    conn: aiosqlite.Connection,
    *,
    token_hash: str,
    user_id: int,
    purpose: str,
    expires_at: datetime,
) -> int:
    cursor = await conn.execute(
        "INSERT INTO setup_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
        (token_hash, user_id, purpose, iso(expires_at)),
    )
    await conn.commit()
    return int(cursor.lastrowid or 0)


async def get_setup_token(conn: aiosqlite.Connection, token_hash: str) -> SetupTokenRow | None:
    cursor = await conn.execute(
        "SELECT id, user_id, purpose, expires_at, used_at FROM setup_tokens WHERE token_hash = ?",
        (token_hash,),
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    expires = parse(row["expires_at"])
    if expires is None:
        return None
    return SetupTokenRow(
        id=int(row["id"]),
        user_id=int(row["user_id"]),
        purpose=str(row["purpose"]),
        expires_at=expires,
        used_at=parse(row["used_at"]),
    )


async def mark_setup_token_used(conn: aiosqlite.Connection, token_id: int) -> None:
    await conn.execute(
        "UPDATE setup_tokens SET used_at = ? WHERE id = ?", (iso(utcnow()), token_id)
    )
    await conn.commit()


# --- login attempts (throttle) ----------------------------------------------------------


async def record_login_attempt(
    conn: aiosqlite.Connection, *, email: str | None, ip: str | None, success: bool
) -> None:
    await conn.execute(
        "INSERT INTO login_attempts (email, ip, success) VALUES (?, ?, ?)",
        (normalize_email(email) if email else None, ip, int(success)),
    )
    await conn.commit()


async def count_recent_failures(
    conn: aiosqlite.Connection, *, email: str | None, ip: str | None, window_minutes: int
) -> int:
    """Failed attempts for this e-mail OR this IP within the window (the max of the two)."""
    since = iso(utcnow() - timedelta(minutes=window_minutes))
    counts: list[int] = []
    if email:
        cursor = await conn.execute(
            "SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND at >= ?",
            (normalize_email(email), since),
        )
        row = await cursor.fetchone()
        counts.append(int(row[0]) if row else 0)
    if ip:
        cursor = await conn.execute(
            "SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND success = 0 AND at >= ?",
            (ip, since),
        )
        row = await cursor.fetchone()
        counts.append(int(row[0]) if row else 0)
    return max(counts) if counts else 0
