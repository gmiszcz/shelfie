"""Tests for scripts.fill_covers — cover discovery, verification, and the full run."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import httpx

from scripts import fill_covers

# A minimal but valid PNG (8-byte signature + padding past the 2 KB floor).
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 4096
TINY = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10  # below MIN_IMAGE_BYTES


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_sniff_image() -> None:
    assert fill_covers._sniff_image(PNG) == "image/png"
    assert fill_covers._sniff_image(b"\xff\xd8\xff\x00") == "image/jpeg"
    assert fill_covers._sniff_image(b"RIFF\x00\x00\x00\x00WEBP") == "image/webp"
    assert fill_covers._sniff_image(b"<html>") is None


def test_verify_rejects_small_and_non_image() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if "small" in str(req.url):
            return httpx.Response(200, content=TINY, headers={"Content-Type": "image/png"})
        if "html" in str(req.url):
            return httpx.Response(200, content=b"x" * 5000, headers={"Content-Type": "text/html"})
        if "notfound" in str(req.url):
            return httpx.Response(404)
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        finder = fill_covers.CoverFinder(c, api_key=None, sleep=lambda s: None, spacing_s=0.0)
        assert finder.verify_image("https://x/small.png") is None
        assert finder.verify_image("https://x/html") is None
        assert finder.verify_image("https://x/notfound.png") is None
        ok = finder.verify_image("https://x/good.png")
        assert ok is not None and ok[1] == "image/png"


def test_429_backs_off_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "1"})
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    slept: list[float] = []
    with _client(handler) as c:
        finder = fill_covers.CoverFinder(c, api_key=None, sleep=slept.append, spacing_s=0.0)
        got = finder.verify_image("https://x/cover.png")
    assert got is not None
    assert slept and slept[0] == 1.0  # honored Retry-After


def test_find_falls_through_google_to_openlibrary_isbn() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "googleapis.com" in url:
            return httpx.Response(200, json={"items": []})  # Google has nothing
        if "covers.openlibrary.org/b/isbn/" in url:
            return httpx.Response(200, content=PNG, headers={"Content-Type": "image/jpeg"})
        return httpx.Response(404)

    with _client(handler) as c:
        finder = fill_covers.CoverFinder(c, api_key="k", sleep=lambda s: None, spacing_s=0.0)
        result = finder.find(
            {"title": "T", "authors": ["A"], "isbn_13": "9780000000001", "language": "pl"}
        )
    assert result.url is not None
    assert result.source == "openlibrary_isbn13"
    assert result.image == PNG


def test_volume_id_source_used_when_isbn_lookups_fail() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "googleapis.com" in url:
            return httpx.Response(200, json={"items": []})  # no imageLinks by ISBN
        if "books.google.com/books/content" in url:
            return httpx.Response(200, content=PNG, headers={"Content-Type": "image/jpeg"})
        return httpx.Response(404)

    with _client(handler) as c:
        finder = fill_covers.CoverFinder(c, api_key="k", sleep=lambda s: None, spacing_s=0.0)
        result = finder.find(
            {"title": "T", "authors": ["A"], "google_volume_id": "VOL123", "language": "pl"}
        )
    assert result.source == "google_volume_id"
    assert result.url is not None and "id=VOL123" in result.url
    assert result.image == PNG


def test_volume_id_placeholder_is_rejected() -> None:
    """Google's ~1.3 KB 'no cover' placeholder must be rejected, not stored."""
    placeholder = b"\x89PNG\r\n\x1a\n" + b"\x00" * 1200  # under MIN_IMAGE_BYTES

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "googleapis.com" in url or "openlibrary.org/search.json" in url:
            return httpx.Response(200, json={"items": [], "docs": []})
        if "books.google.com/books/content" in url:
            return httpx.Response(200, content=placeholder, headers={"Content-Type": "image/png"})
        return httpx.Response(404)

    with _client(handler) as c:
        finder = fill_covers.CoverFinder(c, api_key="k", sleep=lambda s: None, spacing_s=0.0)
        result = finder.find(
            {"title": "No Cover Book", "google_volume_id": "VOLX", "language": "pl"}
        )
    assert result.url is None  # placeholder rejected, nothing else matched


def _seed_live(tmp_path: Path) -> Path:
    """Create a root/data with a books.json and a schema-correct sqlite DB."""
    data = tmp_path / "data"
    data.mkdir()
    books = [
        {
            "external_id": "1",
            "google_volume_id": "VOLA",
            "isbn_13": "9780000000001",
            "isbn_10": None,
            "title": "Needs Cover",
            "authors": ["Author One"],
            "language": "pl",
            "cover_url": None,
        },
        {
            "external_id": "2",
            "google_volume_id": "VOLB",
            "title": "Has Cover",
            "authors": ["Author Two"],
            "cover_url": "https://example/x.jpg",
        },
    ]
    (data / "books.json").write_text(
        json.dumps({"version": 1, "books": books}, ensure_ascii=False), encoding="utf-8"
    )
    db = data / "shelfie.sqlite"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE books (id INTEGER PRIMARY KEY, user_id INTEGER, google_volume_id TEXT, "
        "isbn_13 TEXT, isbn_10 TEXT, external_id TEXT, title TEXT, authors TEXT, cover_url TEXT, "
        "updated_at TEXT)"
    )
    conn.execute("CREATE TABLE comparisons (id INTEGER PRIMARY KEY, user_id INTEGER, winner TEXT)")
    conn.execute(
        "INSERT INTO books (id, user_id, google_volume_id, isbn_13, external_id, title, authors) "
        "VALUES (1, 1, 'VOLA', '9780000000001', '1', 'Needs Cover', '[\"Author One\"]')"
    )
    conn.execute(
        "INSERT INTO books (id, user_id, google_volume_id, external_id, title, authors, cover_url) "
        "VALUES (2, 1, 'VOLB', '2', 'Has Cover', '[\"Author Two\"]', 'https://example/x.jpg')"
    )
    conn.execute("INSERT INTO comparisons (user_id, winner) VALUES (1, 'left')")
    conn.commit()
    conn.close()
    return tmp_path


def test_run_downloads_and_writes_both_stores(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)

    def handler(req: httpx.Request) -> httpx.Response:
        if "googleapis.com" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "items": [{"volumeInfo": {"imageLinks": {"thumbnail": "https://img/c?zoom=1"}}}]
                },
            )
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    def factory(_client: httpx.Client, _key: str | None) -> fill_covers.CoverFinder:
        mock = _client_from(handler)
        return fill_covers.CoverFinder(mock, api_key=None, sleep=lambda s: None, spacing_s=0.0)

    def _client_from(h):
        return httpx.Client(transport=httpx.MockTransport(h))

    rc = fill_covers.run(root, dry_run=False, limit=None, download=True, finder_factory=factory)
    assert rc == 0

    payload = json.loads((root / "data" / "books.json").read_text(encoding="utf-8"))
    needs = next(b for b in payload["books"] if b["external_id"] == "1")
    assert needs["cover_url"].startswith("/api/covers/")
    # The stored file exists.
    name = needs["cover_url"].rsplit("/", 1)[1]
    assert (root / "data" / "covers" / name).read_bytes() == PNG

    conn = sqlite3.connect(root / "data" / "shelfie.sqlite")
    row = conn.execute("SELECT cover_url FROM books WHERE id = 1").fetchone()
    assert row[0] == needs["cover_url"]
    assert conn.execute("SELECT COUNT(*) FROM comparisons").fetchone()[0] == 1
    conn.close()


def test_run_dry_run_writes_nothing(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)
    before = (root / "data" / "books.json").read_text(encoding="utf-8")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    def factory(_c, _k):
        return fill_covers.CoverFinder(
            httpx.Client(transport=httpx.MockTransport(handler)),
            api_key=None,
            sleep=lambda s: None,
            spacing_s=0.0,
        )

    rc = fill_covers.run(root, dry_run=True, limit=None, download=True, finder_factory=factory)
    assert rc == 0
    assert (root / "data" / "books.json").read_text(encoding="utf-8") == before
    # No backup dir created in dry-run.
    assert not list((root / "data").glob("backup-wave4-*"))
