"""Tests for the shared Wave 4 data-IO helpers."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts import _dataio


def _make_db(path: Path, rows: list[dict]) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE books (id INTEGER PRIMARY KEY, user_id INTEGER, google_volume_id TEXT, "
        "isbn_13 TEXT, isbn_10 TEXT, external_id TEXT, title TEXT, authors TEXT, cover_url TEXT)"
    )
    conn.execute("CREATE TABLE comparisons (id INTEGER PRIMARY KEY, user_id INTEGER, winner TEXT)")
    for r in rows:
        conn.execute(
            "INSERT INTO books (id, user_id, google_volume_id, isbn_13, isbn_10, external_id, "
            "title, authors) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
            (
                r["id"],
                r.get("vol"),
                r.get("isbn_13"),
                r.get("isbn_10"),
                r.get("external_id"),
                r.get("title", ""),
                json.dumps(r.get("authors", [])),
            ),
        )
    conn.execute("INSERT INTO comparisons (user_id, winner) VALUES (1, 'left')")
    conn.commit()
    conn.close()


def test_atomic_write_and_load_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "books.json"
    payload = {"version": 1, "books": [{"title": "Żółw", "x": 1}]}
    _dataio.atomic_write_json(path, payload)
    loaded = _dataio.load_dataset(path)
    assert loaded == payload
    # Non-ASCII preserved (ensure_ascii=False).
    assert "Żółw" in path.read_text(encoding="utf-8")


def test_backup_copies_both_stores(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    ds = data_dir / "books.json"
    db = data_dir / "shelfie.sqlite"
    ds.write_text('{"version":1,"books":[]}', encoding="utf-8")
    db.write_bytes(b"SQLITE")
    backup = _dataio.backup_data(data_dir, db, ds)
    assert (backup / "books.json").is_file()
    assert (backup / "shelfie.sqlite").read_bytes() == b"SQLITE"


def test_match_prefers_volume_then_isbn_then_title(tmp_path: Path) -> None:
    db = tmp_path / "db.sqlite"
    _make_db(
        db,
        [
            {
                "id": 10,
                "vol": "VOL1",
                "isbn_13": "111",
                "external_id": "e1",
                "title": "A",
                "authors": ["x"],
            },
            {"id": 20, "isbn_13": "222", "external_id": "e2", "title": "B", "authors": ["y"]},
            {"id": 30, "title": "C", "authors": ["Zoe"]},
        ],
    )
    conn = _dataio.connect_db(db)
    index = _dataio.load_db_index(conn)
    assert _dataio.match_db_id({"google_volume_id": "VOL1"}, index) == 10
    assert _dataio.match_db_id({"isbn_13": "222"}, index) == 20
    assert _dataio.match_db_id({"external_id": "e2"}, index) == 20
    assert _dataio.match_db_id({"title": "C", "authors": ["Zoe"]}, index) == 30
    assert _dataio.match_db_id({"title": "nope"}, index) is None
    assert _dataio.count_comparisons(conn) == 1
    conn.close()


def test_ambiguous_volume_is_not_matched(tmp_path: Path) -> None:
    db = tmp_path / "db.sqlite"
    _make_db(
        db,
        [
            {"id": 1, "vol": "DUP", "title": "A", "authors": []},
            {"id": 2, "vol": "DUP", "title": "B", "authors": []},
        ],
    )
    conn = _dataio.connect_db(db)
    index = _dataio.load_db_index(conn)
    # A duplicated volume id is dropped from the map, so it never matches the wrong row.
    assert _dataio.match_db_id({"google_volume_id": "DUP"}, index) is None
    conn.close()
