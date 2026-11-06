"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

import aiosqlite
from fastapi import Depends

from app.agent.engine import ChatEngine, compose_session_factory
from app.auth import current_user_id
from app.config import Settings, get_settings
from app.db import get_connection
from app.integrations.google_books import GoogleBooksClient


async def db_connection(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncIterator[aiosqlite.Connection]:
    async for conn in get_connection(settings.database_file):
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
    """One engine per process; it owns the chat sessions."""
    return ChatEngine(compose_session_factory(get_settings()))


CurrentUser = Annotated[int, Depends(current_user_id)]
DbConn = Annotated[aiosqlite.Connection, Depends(db_connection)]
BooksClient = Annotated[GoogleBooksClient, Depends(google_books_client)]
AppSettings = Annotated[Settings, Depends(get_settings)]
Chat = Annotated[ChatEngine, Depends(chat_engine)]
