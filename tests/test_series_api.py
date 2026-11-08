"""Integration tests for the series, favourites and waiting-list API."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.db import SINGLE_USER_ID, connect, init_db


def _add(client: TestClient, **fields: object) -> int:
    payload = {"title": "T", "metadata_source": "manual", **fields}
    resp = client.post("/api/books", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_favourite_column_migrates_on_a_copy_of_the_live_db(tmp_path: Path) -> None:
    """A DB missing 'favourite'/'series_info' gains them via the additive migration."""
    db = tmp_path / "old.sqlite"
    # Build a realistic pre-wave-5 schema: the books table has the wave-4 columns
    # (including google_volume_id, which the volume index needs) but NOT 'favourite',
    # and there is no series_info / expected_books table yet.
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE books (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
            google_volume_id TEXT,
            title TEXT NOT NULL DEFAULT '', series TEXT, volume TEXT,
            status TEXT NOT NULL DEFAULT 'want', finished_on TEXT,
            authors TEXT NOT NULL DEFAULT '[]',
            signed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users (id, display_name) VALUES (1, 'U');
        INSERT INTO books (user_id, title) VALUES (1, 'Legacy book');
        """
    )
    conn.commit()
    conn.close()

    asyncio.run(init_db(db))

    check = sqlite3.connect(db)
    cols = {row[1] for row in check.execute("PRAGMA table_info(books)")}
    tables = {row[0] for row in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # Legacy row survived.
    count = check.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    check.close()
    assert "favourite" in cols
    assert "series_info" in tables
    assert "expected_books" in tables
    assert count == 1


def test_favourite_toggle_via_patch(client: TestClient) -> None:
    book_id = _add(client, title="Fav book")
    assert client.get(f"/api/books/{book_id}").json()["favourite"] is False

    resp = client.patch(f"/api/books/{book_id}", json={"favourite": True})
    assert resp.status_code == 200
    assert resp.json()["favourite"] is True

    resp = client.patch(f"/api/books/{book_id}", json={"favourite": False})
    assert resp.json()["favourite"] is False


def test_list_series_and_sections(client: TestClient) -> None:
    _add(
        client,
        title="S1 V1",
        series="My Saga",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    _add(client, title="S1 V2", series="My Saga", volume="2", status="reading")

    resp = client.get("/api/series")
    assert resp.status_code == 200
    series = resp.json()
    assert len(series) == 1
    saga = series[0]
    assert saga["name"] == "My Saga"
    assert saga["owned_count"] == 2
    assert saga["read_count"] == 1
    assert saga["unread_owned_count"] == 1
    assert saga["section"] == "in_progress"


def test_watch_toggle(client: TestClient) -> None:
    _add(
        client,
        title="W1",
        series="Watched Saga",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]

    resp = client.patch(f"/api/series/{key}", json={"watch": True})
    assert resp.status_code == 200
    assert resp.json()["watch"] is True

    resp = client.patch(f"/api/series/{key}", json={"watch": False})
    assert resp.json()["watch"] is False


def test_series_alerts_report_in_progress(client: TestClient) -> None:
    _add(
        client, title="P1", series="InProg", volume="1", status="finished", finished_on="2021-01-01"
    )
    _add(client, title="P2", series="InProg", volume="2", status="reading")

    resp = client.get("/api/series/alerts")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] >= 1
    assert any(a["series_name"] == "InProg" for a in data["in_progress"])


def test_waiting_list_add_list_delete(client: TestClient) -> None:
    resp = client.post(
        "/api/series/expected",
        json={
            "title": "Upcoming Vol",
            "author": "Someone",
            "series_name": "Future Saga",
            "expected_date": "2027-01-01",
        },
    )
    assert resp.status_code == 201, resp.text
    entry = resp.json()
    assert entry["title"] == "Upcoming Vol"
    assert entry["series_key"]  # derived from series_name

    listed = client.get("/api/series/expected").json()
    assert any(e["id"] == entry["id"] for e in listed)

    assert client.delete(f"/api/series/expected/{entry['id']}").status_code == 204
    assert all(e["id"] != entry["id"] for e in client.get("/api/series/expected").json())


def test_get_series_by_alias(client: TestClient, db_file: Path) -> None:
    """A series found by an aliased name resolves to its canonical row."""
    _add(
        client,
        title="Legends of Ahn",
        series="King's Dark Tidings",
        volume="3",
        status="finished",
        finished_on="2022-04-18",
    )

    # Seed the alias directly (same path the service seeds built-ins through).
    async def seed() -> None:
        from app.repositories import series as srepo
        from app.schemas.series import SeriesInfo
        from app.services import series as compute

        conn = await connect(db_file)
        try:
            await srepo.upsert_info(
                conn,
                SINGLE_USER_ID,
                SeriesInfo(
                    series_key=compute.series_key("King's Dark Tidings"),
                    display_name="King's Dark Tidings",
                    aliases=["Kroniki Mroku"],
                ),
            )
        finally:
            await conn.close()

    asyncio.run(seed())

    resp = client.get("/api/series/Kroniki%20Mroku")
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "King's Dark Tidings"
