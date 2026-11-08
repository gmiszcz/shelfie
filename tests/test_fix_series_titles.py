"""Tests for scripts.fix_series_titles — targeted catalogue corrections."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from scripts import fix_series_titles as fix


def test_apply_correction_only_changes_differing_fields() -> None:
    record = {"title": "Droga Szamana", "subtitle": "old", "series": None, "volume": None}
    applied = fix.apply_correction(
        record, {"subtitle": "new", "series": "S", "volume": "1", "title": "Droga Szamana"}
    )
    # title already equal -> not in applied; the rest changed.
    assert set(applied) == {"subtitle", "series", "volume"}
    assert record["series"] == "S"
    assert "title" not in applied


def test_editable_fields_never_include_reading_data() -> None:
    assert "stars" not in fix.EDITABLE_FIELDS
    assert "shelves" not in fix.EDITABLE_FIELDS
    assert "started_on" not in fix.EDITABLE_FIELDS


def test_scan_finds_title_equals_series() -> None:
    books: list[dict[str, Any]] = [
        {
            "external_id": "a",
            "title": "Dar anomalii",
            "series": "Dar anomalii",
            "subtitle": "Ks. 1",
        },
        {"external_id": "b", "title": "Other", "series": "Series X"},
        {"external_id": "c", "title": "X", "series": None},
    ]
    hits = fix.scan_title_equals_series(books)
    assert [b["external_id"] for b in hits] == ["a"]


def _seed(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    books = [
        # Shaman vol 5: series None, subtitle numeric, no description.
        {
            "external_id": "2270250",
            "google_volume_id": "y8rJzgEACAAJ",
            "isbn_13": "9788366873001",
            "title": "Droga Szamana",
            "subtitle": "Szachy Karmadonta. Etap 5",
            "series": None,
            "volume": "5",
            "description": None,
            "stars": 4.5,
            "shelves": ["Fantasy"],
        },
        # Dar anomalii vol 1: no series/volume.
        {
            "external_id": "9121410",
            "google_volume_id": "kbL1zwEACAAJ",
            "isbn_13": "9788396718709",
            "title": "Dar anomalii",
            "subtitle": "Ks. 1",
            "series": None,
            "volume": None,
            "stars": 3.0,
        },
    ]
    (data / "books.json").write_text(
        json.dumps({"version": 1, "books": books}, ensure_ascii=False), encoding="utf-8"
    )
    db = data / "shelfie.sqlite"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE books (id INTEGER PRIMARY KEY, user_id INTEGER, google_volume_id TEXT, "
        "isbn_13 TEXT, isbn_10 TEXT, external_id TEXT, title TEXT, subtitle TEXT, series TEXT, "
        "volume TEXT, description TEXT, authors TEXT, stars REAL, shelves TEXT, updated_at TEXT)"
    )
    conn.execute("CREATE TABLE comparisons (id INTEGER PRIMARY KEY, user_id INTEGER, winner TEXT)")
    conn.execute(
        "INSERT INTO books (id, user_id, google_volume_id, isbn_13, external_id, title, subtitle, "
        "series, volume, stars) VALUES "
        "(1, 1, 'y8rJzgEACAAJ', '9788366873001', '2270250', 'Droga Szamana', "
        "'Szachy Karmadonta. Etap 5', NULL, '5', 4.5)"
    )
    conn.execute(
        "INSERT INTO books (id, user_id, google_volume_id, isbn_13, external_id, title, subtitle, "
        "series, volume, stars) VALUES "
        "(2, 1, 'kbL1zwEACAAJ', '9788396718709', '9121410', 'Dar anomalii', 'Ks. 1', NULL, NULL, 3.0)"
    )
    conn.execute("INSERT INTO comparisons (user_id, winner) VALUES (1, 'tie')")
    conn.commit()
    conn.close()
    return tmp_path


def test_run_applies_fixes_to_both_stores_and_keeps_reading_data(tmp_path: Path) -> None:
    root = _seed(tmp_path)
    rc = fix.run(root, dry_run=False, scan=False)
    assert rc == 0

    payload = json.loads((root / "data" / "books.json").read_text(encoding="utf-8"))
    v5 = next(b for b in payload["books"] if b["external_id"] == "2270250")
    assert v5["series"] == "The Way of the Shaman"
    assert v5["subtitle"] == "Szachy Karmadonta. Etap piąty"
    assert v5["description"] and "Barliona" in v5["description"]
    assert v5["stars"] == 4.5  # reading data untouched
    assert v5["shelves"] == ["Fantasy"]

    dar = next(b for b in payload["books"] if b["external_id"] == "9121410")
    assert dar["series"] == "Dar anomalii"
    assert dar["volume"] == "1"

    conn = sqlite3.connect(root / "data" / "shelfie.sqlite")
    row = conn.execute(
        "SELECT series, subtitle, description, stars FROM books WHERE id = 1"
    ).fetchone()
    assert row[0] == "The Way of the Shaman"
    assert row[1] == "Szachy Karmadonta. Etap piąty"
    assert row[2] and "Barliona" in row[2]
    assert row[3] == 4.5  # DB reading data untouched
    assert conn.execute("SELECT series, volume FROM books WHERE id = 2").fetchone() == (
        "Dar anomalii",
        "1",
    )
    assert conn.execute("SELECT COUNT(*) FROM comparisons").fetchone()[0] == 1
    conn.close()


def test_run_dry_run_writes_nothing(tmp_path: Path) -> None:
    root = _seed(tmp_path)
    before = (root / "data" / "books.json").read_text(encoding="utf-8")
    rc = fix.run(root, dry_run=True, scan=True)
    assert rc == 0
    assert (root / "data" / "books.json").read_text(encoding="utf-8") == before
    assert not list((root / "data").glob("backup-wave4-*"))
