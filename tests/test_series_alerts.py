"""Tests for the series-ux alert seen-state and per-user UI preferences.

Covers: stable alert keys and how they change, seen persistence across reloads, a NEW
alert reappearing after older ones were dismissed, per-user isolation of seen state and
prefs (separate DB files), and the preferences endpoint.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from app.db import SINGLE_USER_ID, connect, init_db
from app.repositories import series as repo
from app.schemas.series import NextExpected, SeriesInfo, SeriesPreferences
from app.services import series_service


def _add(client: TestClient, **fields: object) -> int:
    payload = {"title": "T", "metadata_source": "manual", **fields}
    resp = client.post("/api/books", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed_watched_with_next(
    db_file: Path, series_key: str, next_expected: NextExpected
) -> None:
    conn = await connect(db_file)
    try:
        info = await repo.get_info(conn, SINGLE_USER_ID, series_key) or SeriesInfo(
            series_key=series_key
        )
        info.watch = True
        info.next_expected = next_expected
        await repo.upsert_info(conn, SINGLE_USER_ID, info)
    finally:
        await conn.close()


# --- alert keys --------------------------------------------------------------------------


def test_alert_key_changes_with_date(client: TestClient, db_file: Path) -> None:
    """A new-volume alert's key depends on title+date+status, so a date change is a new key."""
    _add(
        client, title="V1", series="Keyed", volume="1", status="finished", finished_on="2020-01-01"
    )
    key = client.get("/api/series").json()[0]["series_key"]

    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Book Two", date="2026-01-01", status="announced")
        )
    )
    first = client.get("/api/series/alerts").json()
    nv1 = next(a for a in first["new_volume"] if a["series_name"] == "Keyed")
    key_before = nv1["alert_key"]

    # Same series, same title, different date -> a different, unseen alert key.
    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Book Two", date="2026-06-01", status="announced")
        )
    )
    second = client.get("/api/series/alerts").json()
    nv2 = next(a for a in second["new_volume"] if a["series_name"] == "Keyed")
    assert nv2["alert_key"] != key_before


# --- seen persistence --------------------------------------------------------------------


def test_seen_persists_across_reloads(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="S1",
        series="Seenish",
        volume="1",
        status="finished",
        finished_on="2020-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Next One", date="2027-01-01", status="announced")
        )
    )

    before = client.get("/api/series/alerts").json()
    assert before["unseen_count"] >= 1
    nv = next(a for a in before["new_volume"] if a["series_name"] == "Seenish")
    assert nv["seen"] is False

    seen_resp = client.post("/api/series/alerts/seen", json={"alert_keys": [nv["alert_key"]]})
    assert seen_resp.status_code == 200

    # Fresh GET: the dismissed alert stays seen and is not counted.
    after = client.get("/api/series/alerts").json()
    nv_after = next(a for a in after["new_volume"] if a["series_name"] == "Seenish")
    assert nv_after["seen"] is True
    assert after["unseen_count"] == before["unseen_count"] - 1


def test_dismiss_all_zeroes_the_badge(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="A1",
        series="AllGone",
        volume="1",
        status="finished",
        finished_on="2020-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Vol 2", date="2028-01-01", status="announced")
        )
    )
    assert client.get("/api/series/alerts").json()["unseen_count"] >= 1
    resp = client.post("/api/series/alerts/seen", json={"all": True})
    assert resp.status_code == 200
    assert resp.json()["unseen_count"] == 0
    assert client.get("/api/series/alerts").json()["unseen_count"] == 0


def test_new_alert_reappears_after_older_seen(client: TestClient, db_file: Path) -> None:
    """Dismiss the current alert, then a genuinely new one (new date) must show again."""
    _add(
        client,
        title="R1",
        series="Reappear",
        volume="1",
        status="finished",
        finished_on="2020-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Coming", date="2026-01-01", status="announced")
        )
    )
    # Dismiss everything.
    client.post("/api/series/alerts/seen", json={"all": True})
    assert client.get("/api/series/alerts").json()["unseen_count"] == 0

    # A new release date announced -> a new key -> unseen again.
    asyncio.run(
        _seed_watched_with_next(
            db_file, key, NextExpected(title="Coming", date="2026-09-09", status="announced")
        )
    )
    after = client.get("/api/series/alerts").json()
    assert after["unseen_count"] >= 1
    nv = next(a for a in after["new_volume"] if a["series_name"] == "Reappear")
    assert nv["seen"] is False


# --- per-user isolation (separate DB files) ----------------------------------------------


def test_seen_state_and_prefs_are_per_user(tmp_path: Path) -> None:
    """Two users have their own DB file; dismissing / prefs in one never touch the other."""
    db_a = tmp_path / "a" / "shelfie.sqlite"
    db_b = tmp_path / "b" / "shelfie.sqlite"
    asyncio.run(init_db(db_a))
    asyncio.run(init_db(db_b))

    async def run() -> None:
        conn_a = await connect(db_a)
        conn_b = await connect(db_b)
        try:
            # User A dismisses an alert key and sets a filter preference.
            await repo.mark_alerts_seen(
                conn_a, SINGLE_USER_ID, ["new_volume|x|Book|2026|announced"]
            )
            await series_service.set_series_preferences(
                conn_a, SINGLE_USER_ID, SeriesPreferences(filter="watching")
            )
            # User B has neither.
            seen_b = await repo.seen_alert_keys(conn_b, SINGLE_USER_ID)
            assert seen_b == set()
            prefs_b = await series_service.get_series_preferences(conn_b, SINGLE_USER_ID)
            assert prefs_b.filter == "all"

            # User A still has both.
            seen_a = await repo.seen_alert_keys(conn_a, SINGLE_USER_ID)
            assert "new_volume|x|Book|2026|announced" in seen_a
            prefs_a = await series_service.get_series_preferences(conn_a, SINGLE_USER_ID)
            assert prefs_a.filter == "watching"
        finally:
            await conn_a.close()
            await conn_b.close()

    asyncio.run(run())


# --- preferences endpoint ----------------------------------------------------------------


def test_series_preferences_default_and_roundtrip(client: TestClient) -> None:
    default = client.get("/api/preferences/series").json()
    assert default["filter"] == "all"

    put = client.put("/api/preferences/series", json={"filter": "in_progress", "sort": None})
    assert put.status_code == 200
    assert put.json()["filter"] == "in_progress"

    # Restored on the next load.
    assert client.get("/api/preferences/series").json()["filter"] == "in_progress"


def test_series_preferences_reject_unknown_filter(client: TestClient) -> None:
    """An unknown filter id falls back to the safe default rather than being stored raw."""
    put = client.put("/api/preferences/series", json={"filter": "nonsense", "sort": None})
    assert put.status_code == 200
    assert put.json()["filter"] == "all"


# --- migration ---------------------------------------------------------------------------


def test_alert_seen_and_ui_prefs_tables_created(client: TestClient, db_file: Path) -> None:
    """init_db creates the new additive tables on the user's DB."""

    async def check() -> set[str]:
        conn = await connect(db_file)
        try:
            cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            return {row["name"] for row in await cursor.fetchall()}
        finally:
            await conn.close()

    tables = asyncio.run(check())
    assert "alert_seen" in tables
    assert "ui_prefs" in tables
