"""Integration tests for the series-edit API (wave 5): metadata, membership, rename, merge.

Every book change must land in BOTH the DB and data/books.json. These tests point the
dataset file at a temp JSON (monkeypatching the settings) and assert the mirror wrote the
same series/volume the API returned.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.userdata import UserData


def _add(client: TestClient, **fields: object) -> int:
    payload = {"title": "T", "metadata_source": "manual", **fields}
    resp = client.post("/api/books", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.fixture
def dataset(test_user_data: UserData):
    """The current user's books.json, so the mirror writes there.

    The books.json mirror resolves ``current_dataset_file()`` from the per-user data
    context, which the logged-in ``client`` fixture sets to ``test_user_data.dataset_file``.
    """
    path = test_user_data.dataset_file
    path.write_text(json.dumps({"version": 1, "books": []}, ensure_ascii=False), encoding="utf-8")
    yield path, None


def _json_record(path: Path, title: str) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for b in data["books"]:
        if b.get("title") == title:
            return b
    return {}


def _seed_json(path: Path, records: list[dict]) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    data["books"].extend(records)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_patch_series_metadata(client: TestClient) -> None:
    _add(
        client,
        title="M1",
        series="Meta Saga",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]

    resp = client.patch(
        f"/api/series/{key}",
        json={"aliases": ["Alt Name"], "author": "A. Writer", "total_volumes": 9, "notes": "hi"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["author"] == "A. Writer"
    assert body["total_known"] == 9
    assert body["notes"] == "hi"
    assert "Alt Name" in body["aliases"]
    # Found by the new alias.
    assert client.get("/api/series/Alt%20Name").status_code == 200


def test_patch_series_still_toggles_watch(client: TestClient) -> None:
    _add(
        client,
        title="W",
        series="Watch Saga",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    assert client.patch(f"/api/series/{key}", json={"watch": True}).json()["watch"] is True
    assert client.patch(f"/api/series/{key}", json={"watch": False}).json()["watch"] is False


def test_add_remove_and_set_volume_mirror_to_json(client: TestClient, dataset) -> None:
    path, _ = dataset
    # Two JSON records matched by title+authors.
    _seed_json(
        path,
        [
            {"title": "Loose Book", "authors": ["Z"], "series": None, "volume": None},
            {"title": "In Series", "authors": ["Z"], "series": "Z Saga", "volume": "1"},
        ],
    )
    loose = _add(client, title="Loose Book", authors=["Z"])
    _add(client, title="In Series", authors=["Z"], series="Z Saga", volume="1")
    key = client.get("/api/series").json()[0]["series_key"]

    # Add the loose book as volume 2.
    resp = client.post(f"/api/series/{key}/books", json={"book_id": loose, "volume": "2"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["owned_count"] == 2
    assert _json_record(path, "Loose Book")["series"] == "Z Saga"
    assert _json_record(path, "Loose Book")["volume"] == "2"

    # Change its volume to 3.
    resp = client.patch(f"/api/series/{key}/books/{loose}", json={"volume": "3"})
    assert resp.status_code == 200
    assert _json_record(path, "Loose Book")["volume"] == "3"

    # Remove it — series + volume cleared in JSON.
    resp = client.delete(f"/api/series/{key}/books/{loose}")
    assert resp.status_code == 200
    assert _json_record(path, "Loose Book")["series"] is None
    assert _json_record(path, "Loose Book")["volume"] is None


def test_rename_series_rewrites_all_books_and_keeps_alias(client: TestClient, dataset) -> None:
    path, _ = dataset
    _seed_json(
        path,
        [
            {"title": "R1", "authors": ["Q"], "series": "Old Name", "volume": "1"},
            {"title": "R2", "authors": ["Q"], "series": "Old Name", "volume": "2"},
        ],
    )
    _add(client, title="R1", authors=["Q"], series="Old Name", volume="1")
    _add(client, title="R2", authors=["Q"], series="Old Name", volume="2")
    key = client.get("/api/series").json()[0]["series_key"]

    resp = client.post(f"/api/series/{key}/rename", json={"name": "New Name"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "New Name"
    assert "Old Name" in body["aliases"]
    # Both member books renamed in the DB.
    series = client.get("/api/series").json()
    assert len(series) == 1 and series[0]["owned_count"] == 2
    # And in the JSON mirror.
    assert _json_record(path, "R1")["series"] == "New Name"
    assert _json_record(path, "R2")["series"] == "New Name"
    # Still reachable by the old name.
    assert client.get("/api/series/Old%20Name").json()["name"] == "New Name"


def test_merge_series_moves_books_and_aliases(client: TestClient) -> None:
    _add(client, title="A1", authors=["M"], series="Keep", volume="1")
    _add(client, title="B1", authors=["M"], series="Gone", volume="2")
    keep = next(s for s in client.get("/api/series").json() if s["name"] == "Keep")["series_key"]
    gone = next(s for s in client.get("/api/series").json() if s["name"] == "Gone")["series_key"]

    resp = client.post(f"/api/series/{keep}/merge", json={"other_key": gone})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["owned_count"] == 2
    assert "Gone" in body["aliases"]
    # Only one series remains.
    assert len(client.get("/api/series").json()) == 1


def test_add_book_to_new_series_name(client: TestClient) -> None:
    """A series name that does not exist yet is created by adding a book to it."""
    book = _add(client, title="Solo", authors=["N"])
    resp = client.post(
        "/api/series/Brand%20New%20Series/books", json={"book_id": book, "volume": "1"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Brand New Series"
    assert resp.json()["owned_count"] == 1


def test_missing_book_is_404(client: TestClient) -> None:
    _add(client, title="X1", series="X Saga", volume="1")
    key = client.get("/api/series").json()[0]["series_key"]
    assert client.post(f"/api/series/{key}/books", json={"book_id": 99999}).status_code == 404
