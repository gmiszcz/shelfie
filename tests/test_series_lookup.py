"""Tests for the series external lookup, including graceful Google 429 handling.

No network: a fake Google client raises a 429 and OpenLibrary is monkeypatched, so the
suite never touches the real (quota-limited) API. asyncio_mode = "auto" (pyproject) runs
the async tests without an explicit marker.
"""

from __future__ import annotations

import httpx
import pytest

from app.integrations import series_lookup
from app.integrations.google_books import GoogleBooksClient
from app.schemas.books import VolumeSearchResult


class _QuotaExhaustedGoogle(GoogleBooksClient):
    """A Google Books client that always raises HTTP 429 ('Queries per day')."""

    def __init__(self) -> None:
        super().__init__(base_url="http://fake", api_key="k")
        self.calls = 0

    async def search(self, query: str, max_results: int = 20, lang: str | None = None):
        self.calls += 1
        request = httpx.Request("GET", "http://fake/volumes")
        response = httpx.Response(429, request=request, text="Queries per day")
        raise httpx.HTTPStatusError("429", request=request, response=response)


def _make_fake_ol(hits: list[VolumeSearchResult]):
    class FakeOL:
        def __init__(self, _client=None) -> None:
            pass

        async def search(self, query: str, max_results: int = 20, lang: str | None = None):
            return len(hits), list(hits)

    return FakeOL


async def test_google_429_falls_back_to_openlibrary_without_hammering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    google = _QuotaExhaustedGoogle()
    hits = [
        VolumeSearchResult(
            google_volume_id="/works/OL1W", title="Saga, Book #1", published_date="2015"
        ),
        VolumeSearchResult(
            google_volume_id="/works/OL2W", title="Saga, Book #2", published_date="2016"
        ),
    ]
    monkeypatch.setattr(series_lookup, "OpenLibraryClient", _make_fake_ol(hits))

    known, total, status = await series_lookup.lookup_series("Saga", "An Author", google)

    assert status.quota_exhausted is True
    assert status.google_ok is False
    assert "openlibrary" in status.sources
    assert total == 2
    assert {k.number for k in known} == {1.0, 2.0}
    # Stopped calling Google after the first 429 — no hammering the quota.
    assert google.calls == 1
    assert "re-check" in status.note().lower()


async def test_status_note_when_google_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    class OkGoogle(GoogleBooksClient):
        def __init__(self) -> None:
            super().__init__(base_url="http://fake", api_key="k")

        async def search(self, query: str, max_results: int = 20, lang: str | None = None):
            return 1, [
                VolumeSearchResult(
                    google_volume_id="g1", title="Saga, Book #1", published_date="2015"
                )
            ]

    monkeypatch.setattr(series_lookup, "OpenLibraryClient", _make_fake_ol([]))

    known, total, status = await series_lookup.lookup_series("Saga", "An Author", OkGoogle())

    assert status.google_ok is True
    assert status.quota_exhausted is False
    assert total == 1
