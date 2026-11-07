"""Auth business logic: login, sessions, setup/reset links, password change, provisioning.

This is the one place that knows the security rules from ``docs/features/auth.md`` — the
sliding 30-day session, the login throttle, the dummy verify, the single-use setup token,
the last-admin protection and creating a new user's empty data folder. Routes and the CLI
call these functions; they never touch SQL or argon2 directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import aiosqlite

from app import authdb, security
from app.authdb import AuthUser
from app.config import Settings
from app.userdata import UserData

SESSION_COOKIE = "shelfie_session"


class AuthError(Exception):
    """Base for auth failures with a stable code the route maps to a status."""

    def __init__(self, message: str, *, code: str = "error") -> None:
        super().__init__(message)
        self.code = code


class InvalidCredentials(AuthError):
    def __init__(self) -> None:
        super().__init__("Invalid e-mail or password", code="invalid_credentials")


class Throttled(AuthError):
    def __init__(self, retry_after: int) -> None:
        super().__init__("Too many attempts. Try again later.", code="throttled")
        self.retry_after = retry_after


class TokenInvalid(AuthError):
    def __init__(self) -> None:
        super().__init__("This link is invalid, expired or already used.", code="token_invalid")


class LastAdmin(AuthError):
    def __init__(self) -> None:
        super().__init__("The last active admin cannot be disabled or demoted.", code="last_admin")


class WeakPassword(AuthError):
    def __init__(self, minimum: int) -> None:
        super().__init__(f"Password must be at least {minimum} characters.", code="weak_password")


class EmailTaken(AuthError):
    def __init__(self) -> None:
        super().__init__("A user with this e-mail already exists.", code="email_taken")


@dataclass
class LoginResult:
    user: AuthUser
    token: str
    expires_at: datetime


def user_data_for(settings: Settings, user_id: int) -> UserData:
    return UserData.for_user(settings.data_path, user_id)


# --- login / sessions -------------------------------------------------------------------


async def login(
    conn: aiosqlite.Connection,
    settings: Settings,
    *,
    email: str,
    password: str,
    user_agent: str | None,
    ip: str | None,
) -> LoginResult:
    """Verify credentials, enforce the throttle, and open a session on success.

    Unknown e-mail or wrong password both raise :class:`InvalidCredentials` with the same
    generic text, and an unknown e-mail still runs a dummy verify so timing is constant.
    """
    email = authdb.normalize_email(email)
    failures = await authdb.count_recent_failures(
        conn, email=email, ip=ip, window_minutes=settings.login_window_minutes
    )
    if failures >= settings.login_max_attempts:
        raise Throttled(retry_after=settings.login_window_minutes * 60)

    user = await authdb.get_user_by_email(conn, email)
    stored_hash = await authdb.get_password_hash(conn, user.id) if user else None
    ok = security.verify_password(stored_hash, password)
    if not user or user.disabled or not ok:
        await authdb.record_login_attempt(conn, email=email, ip=ip, success=False)
        raise InvalidCredentials()

    await authdb.record_login_attempt(conn, email=email, ip=ip, success=True)
    return await open_session(conn, settings, user, user_agent=user_agent, ip=ip)


async def open_session(
    conn: aiosqlite.Connection,
    settings: Settings,
    user: AuthUser,
    *,
    user_agent: str | None,
    ip: str | None,
) -> LoginResult:
    token = security.generate_token()
    expires = authdb.utcnow() + timedelta(days=settings.session_days)
    await authdb.create_session(
        conn,
        token_hash=security.hash_token(token),
        user_id=user.id,
        expires_at=expires,
        user_agent=user_agent,
        ip=ip,
    )
    return LoginResult(user=user, token=token, expires_at=expires)


async def resolve_session(
    conn: aiosqlite.Connection, settings: Settings, token: str | None
) -> AuthUser | None:
    """Return the logged-in user for a cookie token, sliding the expiry when needed.

    ``None`` when the token is missing, unknown, expired, or belongs to a disabled user.
    When fewer than ``session_renew_days`` remain the expiry is pushed back to
    ``session_days`` (the sliding window).
    """
    if not token:
        return None
    row = await authdb.get_session_by_token_hash(conn, security.hash_token(token))
    if row is None:
        return None
    now = authdb.utcnow()
    if row.expires_at <= now:
        await authdb.delete_session(conn, row.id)
        return None
    user = await authdb.get_user(conn, row.user_id)
    if user is None or user.disabled:
        await authdb.delete_session(conn, row.id)
        return None
    # Sliding renewal: extend only when close to expiry so we are not writing every request.
    remaining = row.expires_at - now
    if remaining < timedelta(days=settings.session_renew_days):
        await authdb.touch_session(
            conn, row.id, expires_at=now + timedelta(days=settings.session_days)
        )
    else:
        await authdb.touch_session(conn, row.id)
    return user


async def logout(conn: aiosqlite.Connection, token: str | None) -> None:
    if not token:
        return
    row = await authdb.get_session_by_token_hash(conn, security.hash_token(token))
    if row is not None:
        await authdb.delete_session(conn, row.id)


# --- password change --------------------------------------------------------------------


async def change_password(
    conn: aiosqlite.Connection,
    settings: Settings,
    *,
    user: AuthUser,
    current_password: str,
    new_password: str,
    current_token: str | None,
) -> None:
    """Change a password after verifying the old one; revoke every OTHER session."""
    stored = await authdb.get_password_hash(conn, user.id)
    if not security.verify_password(stored, current_password):
        raise InvalidCredentials()
    if len(new_password) < settings.password_min_length:
        raise WeakPassword(settings.password_min_length)
    await authdb.set_password(conn, user.id, security.hash_password(new_password))
    keep = None
    if current_token:
        row = await authdb.get_session_by_token_hash(conn, security.hash_token(current_token))
        keep = row.id if row else None
    await authdb.delete_sessions_for_user(conn, user.id, except_session_id=keep)


# --- setup / reset links ----------------------------------------------------------------


async def issue_setup_link(
    conn: aiosqlite.Connection,
    settings: Settings,
    *,
    user_id: int,
    purpose: str,
    origin: str,
) -> tuple[str, datetime]:
    """Create a single-use setup/reset link, invalidating the user's older unused ones."""
    await authdb.invalidate_user_setup_tokens(conn, user_id)
    token = security.generate_token()
    expires = authdb.utcnow() + timedelta(hours=settings.setup_token_hours)
    await authdb.create_setup_token(
        conn,
        token_hash=security.hash_token(token),
        user_id=user_id,
        purpose=purpose,
        expires_at=expires,
    )
    return f"{origin.rstrip('/')}/setup?token={token}", expires


async def read_setup_token(conn: aiosqlite.Connection, token: str) -> tuple[AuthUser, str]:
    """Return ``(user, purpose)`` for a valid setup token, else raise :class:`TokenInvalid`."""
    row = await authdb.get_setup_token(conn, security.hash_token(token))
    if row is None or row.used_at is not None or row.expires_at <= authdb.utcnow():
        raise TokenInvalid()
    user = await authdb.get_user(conn, row.user_id)
    if user is None or user.disabled:
        raise TokenInvalid()
    return user, row.purpose


async def complete_setup(
    conn: aiosqlite.Connection,
    settings: Settings,
    *,
    token: str,
    password: str,
    user_agent: str | None,
    ip: str | None,
) -> LoginResult:
    """Consume a setup token, set the password, and log the person in."""
    row = await authdb.get_setup_token(conn, security.hash_token(token))
    if row is None or row.used_at is not None or row.expires_at <= authdb.utcnow():
        raise TokenInvalid()
    user = await authdb.get_user(conn, row.user_id)
    if user is None or user.disabled:
        raise TokenInvalid()
    if len(password) < settings.password_min_length:
        raise WeakPassword(settings.password_min_length)
    await authdb.set_password(conn, user.id, security.hash_password(password))
    await authdb.mark_setup_token_used(conn, row.id)
    # A password set revokes any stale sessions, then we open a fresh one.
    await authdb.delete_sessions_for_user(conn, user.id)
    return await open_session(conn, settings, user, user_agent=user_agent, ip=ip)


# --- user provisioning / admin ----------------------------------------------------------


async def create_account(
    conn: aiosqlite.Connection,
    settings: Settings,
    *,
    email: str,
    display_name: str,
    is_admin: bool = False,
    user_id: int | None = None,
) -> AuthUser:
    """Create a user and their empty data folder. Raises :class:`EmailTaken` on a dup."""
    if await authdb.get_user_by_email(conn, email) is not None:
        raise EmailTaken()
    user = await authdb.create_user(
        conn, email=email, display_name=display_name, is_admin=is_admin, user_id=user_id
    )
    # An empty library folder for the new person (a fresh DB is created on first access).
    user_data_for(settings, user.id).ensure_dirs()
    return user


async def set_user_flags(
    conn: aiosqlite.Connection,
    *,
    user_id: int,
    display_name: str | None = None,
    disabled: bool | None = None,
    is_admin: bool | None = None,
) -> AuthUser | None:
    """Update a user, protecting the last active admin and revoking sessions on disable."""
    user = await authdb.get_user(conn, user_id)
    if user is None:
        return None

    # Last-admin protection: do not let the only active admin be disabled or demoted.
    admins = await authdb.count_active_admins(conn)
    disabling_only_admin = disabled is True and user.is_admin and not user.disabled and admins <= 1
    demoting_only_admin = is_admin is False and user.is_admin and not user.disabled and admins <= 1
    if disabling_only_admin or demoting_only_admin:
        raise LastAdmin()

    updated = await authdb.update_user(
        conn, user_id, display_name=display_name, disabled=disabled, is_admin=is_admin
    )
    if disabled is True and updated is not None:
        await authdb.delete_sessions_for_user(conn, user_id)
    return updated


async def book_count(user_data: UserData) -> int:
    """Number of books in a user's library (0 when the DB does not exist yet)."""
    db_file: Path = user_data.database_file
    if not db_file.is_file():
        return 0
    conn = await aiosqlite.connect(db_file)
    try:
        cursor = await conn.execute("SELECT COUNT(*) FROM books")
        row = await cursor.fetchone()
        return int(row[0]) if row else 0
    except aiosqlite.Error:
        return 0
    finally:
        await conn.close()
