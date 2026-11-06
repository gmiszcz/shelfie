"""Seed insert-path integration test.

Exercises the real repository against a real temp SQLite DB, using a volume normalized exactly
as the Google Books client produces it. This proves the seed → DB path independently of the live
Google Books quota (which the network call itself is subject to).
"""

from __future__ import annotations

from pathlib import Path

from app.db import SINGLE_USER_ID, connect, init_db
from app.integrations.google_books import normalize_volume
from app.repositories import books as repo
from app.schemas.books import BookCreate, ReadingStatus

VOLUME_JSON = {
    "id": "vol-dune",
    "volumeInfo": {
        "title": "Dune",
        "authors": ["Frank Herbert"],
        "publishedDate": "1965",
        "description": "Desert planet epic.",
        "industryIdentifiers": [{"type": "ISBN_13", "identifier": "9780441013593"}],
        "imageLinks": {"thumbnail": "http://books.google.com/x?id=d&zoom=1&edge=curl"},
    },
}


async def test_seed_insert_path(tmp_path: Path) -> None:
    db_file = tmp_path / "seed.sqlite"
    await init_db(db_file)
    conn = await connect(db_file)
    try:
        volume = normalize_volume(VOLUME_JSON)
        payload = BookCreate(**volume.model_dump(), status=ReadingStatus.want)
        await repo.create_book(conn, SINGLE_USER_ID, payload)

        books = await repo.list_books(conn, SINGLE_USER_ID)
        assert len(books) == 1
        assert books[0].title == "Dune"
        assert books[0].isbn_13 == "9780441013593"
        assert books[0].cover_url is not None
        assert books[0].cover_url.startswith("https://")

        # Idempotent re-seed: same volume id is found and would be skipped.
        found = await repo.find_by_volume_id(conn, SINGLE_USER_ID, "vol-dune")
        assert found is not None
    finally:
        await conn.close()
