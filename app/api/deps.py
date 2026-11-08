"""Shared FastAPI dependencies.

Request scoping lives here. ``current_user`` resolves the session cookie to an
:class:`~app.authdb.AuthUser`, sets the per-user :data:`~app.userdata.CURRENT_USER_DATA`
context var, and makes the user's library DB exist on first access. ``db_connection`` then
opens a connection to *that* user's SQLite file — never a global one. Code with no request
object (agent tools, background tasks) reads the same context var.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

import aiosqlite
from fastapi import Depends, Request

from app.agent.engine import ChatEngine, compose_session_factory
from app.authdb import AuthUser, get_auth_connection
from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.integrations.google_books import GoogleBooksClient
from app.services import auth_service
from app.services.auth_service import SESSION_COOKIE
from app.userdata import UserData, set_current_user_data


def client_ip(request: Request) -> str | None:
    """The caller's IP for the login throttle, hard to spoof.

    ``Fly-Client-IP`` is set by the Fly.io edge and overwrites any client value. Else the
    LAST ``X-Forwarded-For`` hop (added by our own proxy); the first hop is whatever the
    client sent, so trusting it would let anyone dodge the throttle.
    """
    fly = request.headers.get("fly-client-ip", "").strip()
    if fly:
        return fly
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.client.host if request.client else None


async def auth_connection(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncIterator[aiosqlite.Connection]:
    async for conn in get_auth_connection(settings.auth_database_file):
        yield conn


AuthConn = Annotated[aiosqlite.Connection, Depends(auth_connection)]


async def current_user(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    auth_conn: AuthConn,
) -> AuthUser:
    """Resolve the session cookie to a user, or 401. Sets the per-user data context.

    Every protected route depends on this (directly or via the global guard), so the
    context var is always set before any library data is touched.
    """
    from fastapi import HTTPException, status

    token = request.cookies.get(SESSION_COOKIE)
    user = await auth_service.resolve_session(auth_conn, settings, token)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user_data = UserData.for_user(settings.data_path, user.id)
    user_data.ensure_dirs()
    await init_db(user_data.database_file)
    set_current_user_data(user_data)
    return user


CurrentAuthUser = Annotated[AuthUser, Depends(current_user)]


async def require_admin(user: CurrentAuthUser) -> AuthUser:
    from fastapi import HTTPException, status

    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


AdminUser = Annotated[AuthUser, Depends(require_admin)]


async def db_connection(
    user: CurrentAuthUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncIterator[aiosqlite.Connection]:
    """Open a connection to the CURRENT user's library DB.

    Depends on ``current_user`` so the context var is set and the DB initialised first.
    """
    user_data = UserData.for_user(settings.data_path, user.id)
    async for conn in get_connection(user_data.database_file):
        yield conn


def google_books_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> GoogleBooksClient:
    return GoogleBooksClient(
        base_url=settings.google_books_base_url,
        api_key=settings.google_books_api_key,
    )


@lru_cache(maxsize=1)
def chat_engine() -> ChatEngine:
    """One engine per process; it owns the chat sessions (keyed by user + session id)."""
    return ChatEngine(compose_session_factory(get_settings()))


#: Backward-compatible alias: routes still take ``user_id: CurrentUser`` as the per-user
#: library id. Inside a per-user database that id is always the single-user constant 1
#: (isolation is by file, see docs/features/auth.md), so library queries keep working
#: unchanged while the account identity is carried separately by ``current_user``.
def current_user_id(_user: CurrentAuthUser) -> int:
    from app.db import SINGLE_USER_ID

    return SINGLE_USER_ID


CurrentUser = Annotated[int, Depends(current_user_id)]
DbConn = Annotated[aiosqlite.Connection, Depends(db_connection)]
BooksClient = Annotated[GoogleBooksClient, Depends(google_books_client)]
AppSettings = Annotated[Settings, Depends(get_settings)]
Chat = Annotated[ChatEngine, Depends(chat_engine)]
