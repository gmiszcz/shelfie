"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

import aiosqlite
from fastapi import Depends

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


CurrentUser = Annotated[int, Depends(current_user_id)]
DbConn = Annotated[aiosqlite.Connection, Depends(db_connection)]
BooksClient = Annotated[GoogleBooksClient, Depends(google_books_client)]
