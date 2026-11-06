"""Test fixtures: an isolated temp DB and a fake Google Books client."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import aiosqlite
import pytest
from fastapi.testclient import TestClient

from app.api.deps import db_connection, google_books_client
from app.db import get_connection, init_db
from app.integrations.google_books import GoogleBooksClient
from app.main import app
from app.schemas.books import VolumeSearchResult


class FakeGoogleBooksClient(GoogleBooksClient):
    """Returns canned results without any network call."""

    def __init__(self, results: list[VolumeSearchResult] | None = None) -> None:
        super().__init__(base_url="http://fake")
        self.results = results or [
            VolumeSearchResult(
                google_volume_id="vol-dune",
                title="Dune",
                authors=["Frank Herbert"],
                published_date="1965",
                description="Desert planet epic.",
                isbn_13="9780441013593",
                cover_url="https://example.test/dune.jpg",
            )
        ]

    async def search(self, query: str, max_results: int = 20):
        return len(self.results), list(self.results)


@pytest.fixture
def db_file(tmp_path: Path) -> Path:
    return tmp_path / "test.sqlite"


@pytest.fixture
def fake_books() -> FakeGoogleBooksClient:
    return FakeGoogleBooksClient()


@pytest.fixture
def client(db_file: Path, fake_books: FakeGoogleBooksClient) -> Iterator[TestClient]:
    async def override_db() -> AsyncIterator[aiosqlite.Connection]:
        async for conn in get_connection(db_file):
            yield conn

    def override_books() -> GoogleBooksClient:
        return fake_books

    app.dependency_overrides[db_connection] = override_db
    app.dependency_overrides[google_books_client] = override_books

    import asyncio

    asyncio.run(init_db(db_file))

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()
