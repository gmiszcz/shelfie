"""Test fixtures: an isolated temp DB and a fake Google Books client."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import aiosqlite
import pytest
from fastapi.testclient import TestClient

from app.api.deps import db_connection, google_books_client
from app.config import get_settings
from app.db import get_connection, init_db
from app.integrations.google_books import GoogleBooksClient
from app.main import app
from app.schemas.books import VolumeSearchResult


@pytest.fixture(autouse=True)
def _no_bedrock_enrichment(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Disable the Bedrock insights enrichment for every test, neutralise the Google
    Books per-process budget, and isolate every on-disk cache.

    Adding a book normally schedules ``enrich_book`` (a real Bedrock structured-output
    call) and the sync ``/enrich`` endpoint runs it inline — both would make network/model
    calls in the suite and blow the time budget. ``get_settings`` is lru-cached, so we flip
    ``enrichment_enabled`` on the single cached instance for the duration of each test.

    The worktree's ``.env`` may set ``GOOGLE_BOOKS_MAX_CALLS=0`` (so a locally-started
    backend never calls the API); that must not make the MockTransport-based Google Books /
    OpenLibrary tests fail on the budget guard, so we also raise the cap and reset the
    per-process counter. Finally we point the Google Books and web caches at a fresh temp
    dir so a stale cache file never short-circuits a MockTransport test (real network is
    never reached — those tests inject a mock transport).
    """
    from app.integrations import google_books

    settings = get_settings()
    cache_root = tmp_path_factory.mktemp("caches")
    original = {
        "enrichment_enabled": settings.enrichment_enabled,
        "google_books_max_calls": settings.google_books_max_calls,
        "google_books_cache_dir": settings.google_books_cache_dir,
        "web_cache_dir": settings.web_cache_dir,
    }
    settings.enrichment_enabled = False
    if settings.google_books_max_calls < 50:
        settings.google_books_max_calls = 50
    settings.google_books_cache_dir = str(cache_root / "google_books")
    settings.web_cache_dir = str(cache_root / "web")
    google_books._reset_call_count()
    yield
    for key, value in original.items():
        setattr(settings, key, value)
    google_books._reset_call_count()


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

    async def search(self, query: str, max_results: int = 20, lang: str | None = None):
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
