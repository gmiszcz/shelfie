"""HTTP caching tests: cover Cache-Control, and ETag/If-None-Match → 304 on list GETs.

These back the frontend data-cache work (docs/features/data-cache.md): covers are
immutable and private so the browser can hold them for a year, and GET /api/books /
GET /api/series carry a strong ETag so a background refetch of unchanged data is a
bodyless 304.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _sample_book() -> dict:
    return {
        "google_volume_id": "vol-cache-1",
        "title": "Caching for Fun and Profit",
        "authors": ["Ada Lovelace"],
        "status": "want",
    }


# --- cover headers -----------------------------------------------------------------------


def test_cover_response_is_private_immutable(client: TestClient) -> None:
    url = client.post("/api/covers", files={"file": ("c.png", PNG, "image/png")}).json()["url"]
    resp = client.get(url)
    assert resp.status_code == 200
    cache_control = resp.headers["cache-control"]
    assert "private" in cache_control
    assert "max-age=31536000" in cache_control
    assert "immutable" in cache_control


# --- GET /api/books ETag -----------------------------------------------------------------


def test_books_list_sends_etag(client: TestClient) -> None:
    resp = client.get("/api/books")
    assert resp.status_code == 200
    assert resp.headers.get("etag")
    assert "private" in resp.headers.get("cache-control", "")


def test_books_if_none_match_returns_304(client: TestClient) -> None:
    client.post("/api/books", json=_sample_book())
    first = client.get("/api/books")
    etag = first.headers["etag"]

    second = client.get("/api/books", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    # The 304 still carries the ETag so the client keeps revalidating against it.
    assert second.headers["etag"] == etag


def test_books_etag_changes_when_data_changes(client: TestClient) -> None:
    etag_empty = client.get("/api/books").headers["etag"]
    client.post("/api/books", json=_sample_book())
    etag_one = client.get("/api/books").headers["etag"]
    assert etag_empty != etag_one

    # A stale ETag no longer matches → full 200 body with the new list.
    resp = client.get("/api/books", headers={"If-None-Match": etag_empty})
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.headers["etag"] == etag_one


# --- GET /api/series ETag ----------------------------------------------------------------


def test_series_list_sends_etag_and_304(client: TestClient) -> None:
    first = client.get("/api/series")
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert etag

    second = client.get("/api/series", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    assert second.headers["etag"] == etag
