"""Search endpoint and Google Books normalization tests."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.integrations.google_books import (
    GoogleBooksBudgetExceeded,
    _best_cover,
    normalize_volume,
)
from app.integrations.openlibrary import OpenLibraryClient
from app.schemas.books import VolumeSearchResult
from tests.conftest import FakeGoogleBooksClient


def test_search_returns_results(client: TestClient) -> None:
    resp = client.get("/api/search", params={"q": "dune"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_items"] == 1
    assert body["items"][0]["title"] == "Dune"


def test_search_requires_query(client: TestClient) -> None:
    assert client.get("/api/search", params={"q": ""}).status_code == 422


def test_best_cover_upgrades_url() -> None:
    url = _best_cover(
        {"thumbnail": "http://books.google.com/books?id=x&zoom=1&edge=curl&source=gbs_api"}
    )
    assert url is not None
    assert url.startswith("https://")
    assert "edge=curl" not in url
    assert "fife=w800" in url


def test_best_cover_empty() -> None:
    assert _best_cover({}) is None


def test_normalize_volume_extracts_isbns() -> None:
    item = {
        "id": "abc",
        "volumeInfo": {
            "title": "Test Book",
            "authors": ["A. Author"],
            "industryIdentifiers": [
                {"type": "ISBN_10", "identifier": "0000000000"},
                {"type": "ISBN_13", "identifier": "9780000000000"},
            ],
        },
    }
    volume = normalize_volume(item)
    assert volume.isbn_10 == "0000000000"
    assert volume.isbn_13 == "9780000000000"
    assert volume.title == "Test Book"


def test_normalize_volume_missing_fields() -> None:
    volume = normalize_volume({"id": "x", "volumeInfo": {}})
    assert volume.title == "Untitled"
    assert volume.authors == []
    assert volume.cover_url is None


def _quota_error() -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "http://fake/volumes")
    response = httpx.Response(429, request=request, text="Queries per day")
    return httpx.HTTPStatusError("429", request=request, response=response)


def _raising(exc: Exception):
    async def _search(query, max_results=20, lang=None):  # noqa: ANN001, ARG001
        raise exc

    return _search


def _openlibrary(items: list[VolumeSearchResult]):
    async def _search(self, query, max_results=20, lang=None):  # noqa: ANN001, ARG001
        return len(items), items

    return _search


HIT = VolumeSearchResult(title="Droga Szamana", authors=["Wasilij Machanienko"])


def test_budget_spent_falls_back_with_notice(
    client: TestClient, fake_books: FakeGoogleBooksClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fake_books, "search", _raising(GoogleBooksBudgetExceeded("budget")))
    monkeypatch.setattr(OpenLibraryClient, "search", _openlibrary([HIT]))
    resp = client.get("/api/search", params={"q": "droga szamana"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"][0]["title"] == "Droga Szamana"
    assert "tomorrow" in body["notice"]


def test_quota_and_no_openlibrary_hits_says_try_tomorrow(
    client: TestClient, fake_books: FakeGoogleBooksClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fake_books, "search", _raising(_quota_error()))
    monkeypatch.setattr(OpenLibraryClient, "search", _openlibrary([]))
    resp = client.get("/api/search", params={"q": "droga szamana"})
    assert resp.status_code == 429
    assert "tomorrow" in resp.json()["detail"]
