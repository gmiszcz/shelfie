"""Search endpoint and Google Books normalization tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.integrations.google_books import _best_cover, normalize_volume


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
