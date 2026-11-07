"""Tests for scripts.attach_cover — attach one known cover URL to one book in both stores."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import httpx

from scripts import attach_cover

# A valid PNG comfortably past the 2 KB floor, and a too-small one.
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 4096
TINY = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10


def _seed_live(tmp_path: Path) -> Path:
    """Create root/data with a books.json and a schema-correct sqlite DB (one book needs a cover)."""
    data = tmp_path / "data"
    data.mkdir()
    books = [
        {
            "external_id": "21357301",
            "google_volume_id": "sfgU0gEACAAJ",
            "isbn_13": "9788368591446",
            "isbn_10": "8368591449",
            "title": "Cesarstwo świtu",
            "authors": ["Jay Kristoff"],
            "language": "pl",
            "cover_url": None,
        },
        {
            "external_id": "999",
            "google_volume_id": "VOLB",
            "title": "Has Cover",
            "authors": ["Someone"],
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
        "INSERT INTO books (id, user_id, google_volume_id, isbn_13, isbn_10, external_id, title, "
        "authors) VALUES (3, 1, 'sfgU0gEACAAJ', '9788368591446', '8368591449', '21357301', "
        "'Cesarstwo świtu', '[\"Jay Kristoff\"]')"
    )
    conn.execute("INSERT INTO comparisons (user_id, winner) VALUES (1, 'left')")
    conn.commit()
    conn.close()
    return tmp_path


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def test_attach_writes_both_stores(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        rc = attach_cover.attach(
            root, "21357301", "https://shop.example/cover.jpg", dry_run=False, client=c
        )
    assert rc == 0

    payload = json.loads((root / "data" / "books.json").read_text(encoding="utf-8"))
    book = next(b for b in payload["books"] if b["external_id"] == "21357301")
    assert book["cover_url"].startswith("/api/covers/")
    name = book["cover_url"].rsplit("/", 1)[1]
    assert (root / "data" / "covers" / name).read_bytes() == PNG

    conn = sqlite3.connect(root / "data" / "shelfie.sqlite")
    row = conn.execute("SELECT cover_url FROM books WHERE id = 3").fetchone()
    assert row[0] == book["cover_url"]
    # Comparison log untouched.
    assert conn.execute("SELECT COUNT(*) FROM comparisons").fetchone()[0] == 1
    conn.close()


def test_attach_rejects_non_image(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)
    before = (root / "data" / "books.json").read_text(encoding="utf-8")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>not found</html>" * 500, headers={"Content-Type": "text/html"}
        )

    with _client(handler) as c:
        rc = attach_cover.attach(
            root, "21357301", "https://shop.example/page.html", dry_run=False, client=c
        )
    assert rc == 3
    # Nothing written, no backup created.
    assert (root / "data" / "books.json").read_text(encoding="utf-8") == before
    assert not list((root / "data").glob("backup-wave4-*"))


def test_attach_rejects_tiny_placeholder(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=TINY, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        rc = attach_cover.attach(
            root, "21357301", "https://shop.example/placeholder.png", dry_run=False, client=c
        )
    assert rc == 3


def test_attach_dry_run_writes_nothing(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)
    before = (root / "data" / "books.json").read_text(encoding="utf-8")

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        rc = attach_cover.attach(
            root, "21357301", "https://shop.example/cover.jpg", dry_run=True, client=c
        )
    assert rc == 0
    assert (root / "data" / "books.json").read_text(encoding="utf-8") == before
    assert not list((root / "data").glob("backup-wave4-*"))


def test_attach_unknown_external_id(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        rc = attach_cover.attach(root, "does-not-exist", "https://x/y.jpg", dry_run=False, client=c)
    assert rc == 2


def test_attach_skips_book_with_existing_cover(tmp_path: Path) -> None:
    root = _seed_live(tmp_path)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=PNG, headers={"Content-Type": "image/png"})

    with _client(handler) as c:
        rc = attach_cover.attach(root, "999", "https://x/y.jpg", dry_run=False, client=c)
    assert rc == 0
    # The existing cover is unchanged.
    payload = json.loads((root / "data" / "books.json").read_text(encoding="utf-8"))
    book = next(b for b in payload["books"] if b["external_id"] == "999")
    assert book["cover_url"] == "https://example/x.jpg"
