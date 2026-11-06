"""Dataset (data/books.json) -> database tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.db import SINGLE_USER_ID, connect
from app.repositories import books as repo
from app.services import dataset

RECORDS: list[dict[str, Any]] = [
    {
        "external_id": "1",
        "google_volume_id": "vol-a",
        "title": "Droga Szamana",
        "subtitle": "Początek. Etap pierwszy",
        "authors": ["Wasilij Machanienko"],
        "status": "finished",
        "stars": 5,
        "started_on": "2020-09-23",
        "finished_on": "2020-09-25",
        "shelves": ["Fantasy"],
        "tags": ["Lit RPG"],
        "series": "The Way of the Shaman",
        "volume": "1",
        "added_at": "2020-09-27",
        "metadata_source": "google_isbn",
    },
    {
        "external_id": "2",
        "title": "Błyski",
        "authors": ["Kamila Bryksy"],
        "status": "finished",
        "stars": 3.5,
        "finished_on": "2026-07-07",
        "shelves": ["Thriller"],
        "metadata_source": "csv",
    },
    {"external_id": "3", "title": "", "authors": []},  # invalid: empty title
]


def _write(path: Path, records: list[dict], version: int = 1) -> Path:
    path.write_text(json.dumps({"version": version, "books": records}), encoding="utf-8")
    return path


async def test_build_loads_every_valid_book(tmp_path: Path) -> None:
    db_file = tmp_path / "lib.sqlite"
    report = await dataset.load_into_db(db_file, _write(tmp_path / "books.json", RECORDS))
    assert (report.loaded, report.skipped, report.total_in_file) == (2, 1, 3)

    conn = await connect(db_file)
    try:
        books = {b.title: b for b in await repo.list_books(conn, SINGLE_USER_ID)}
    finally:
        await conn.close()
    shaman = books["Droga Szamana"]
    assert shaman.finished_on is not None and shaman.finished_on.isoformat() == "2020-09-25"
    assert shaman.shelves == ["Fantasy"] and shaman.tags == ["Lit RPG"]
    assert shaman.added_at == "2020-09-27"


async def test_build_twice_does_not_duplicate(tmp_path: Path) -> None:
    db_file = tmp_path / "lib.sqlite"
    source = _write(tmp_path / "books.json", RECORDS)
    await dataset.load_into_db(db_file, source)
    await dataset.load_into_db(db_file, source)
    conn = await connect(db_file)
    try:
        assert len(await repo.list_books(conn, SINGLE_USER_ID)) == 2
    finally:
        await conn.close()


async def test_sample_loads_a_subset(tmp_path: Path) -> None:
    report = await dataset.load_into_db(
        tmp_path / "lib.sqlite", _write(tmp_path / "books.json", RECORDS), sample=1, seed=7
    )
    assert report.loaded == 1


async def test_wrong_version_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(dataset.DatasetError):
        await dataset.load_into_db(
            tmp_path / "lib.sqlite", _write(tmp_path / "books.json", RECORDS, version=99)
        )


async def test_missing_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(dataset.DatasetError):
        await dataset.load_into_db(tmp_path / "lib.sqlite", tmp_path / "nope.json")
