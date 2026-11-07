"""Tests for the alias-based series/volume fix dry-run (steering: Kel Kade case).

Seeds ``series_info`` with known volumes so the matcher runs offline (no Google call):
books by the same author whose title matches a known volume are proposed as fixes, and
the live data is NEVER modified — the service only returns the proposed changes.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from app.db import SINGLE_USER_ID, connect
from app.repositories import series as srepo
from app.schemas.series import KnownVolume, SeriesInfo
from app.services import series as compute
from app.services import series_service


def _add(client: TestClient, **fields: object) -> int:
    resp = client.post("/api/books", json={"metadata_source": "manual", **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_suggest_series_fixes_matches_untagged_books_and_never_writes(
    client: TestClient, db_file: Path
) -> None:
    # One tagged volume (so the series exists) + two untagged books by the same author.
    tagged = _add(
        client,
        title="Legends of Ahn",
        authors=["Kel Kade"],
        series="King's Dark Tidings",
        volume="3",
        status="finished",
        finished_on="2022-01-01",
    )
    untagged1 = _add(
        client,
        title="Free the Darkness",
        authors=["Kel Kade"],
        status="finished",
        finished_on="2021-01-01",
    )
    untagged2 = _add(
        client,
        title="Kingdoms and Chaos",
        authors=["Kel Kade"],
        status="finished",
        finished_on="2022-06-01",
    )

    async def seed_and_run():
        conn = await connect(db_file)
        try:
            key = compute.series_key("King's Dark Tidings")
            await srepo.upsert_info(
                conn,
                SINGLE_USER_ID,
                SeriesInfo(
                    series_key=key,
                    display_name="King's Dark Tidings",
                    author="Kel Kade",
                    aliases=["Kroniki Mroku"],
                    known_volumes=[
                        KnownVolume(number=1, title="Free the Darkness"),
                        KnownVolume(number=3, title="Legends of Ahn"),
                        KnownVolume(number=5, title="Kingdoms and Chaos"),
                    ],
                    total_known=5,
                ),
            )
            return await series_service.suggest_series_fixes(conn, SINGLE_USER_ID, "Kroniki Mroku")
        finally:
            await conn.close()

    fixes = asyncio.run(seed_and_run())
    by_id = {f["book_id"]: f for f in fixes}

    # The two untagged books are proposed with the matched volume numbers.
    assert untagged1 in by_id
    assert by_id[untagged1]["new_volume"] == "1"
    assert by_id[untagged1]["new_series"] == "King's Dark Tidings"
    assert untagged2 in by_id
    assert by_id[untagged2]["new_volume"] == "5"
    # The already-correct tagged volume is NOT proposed.
    assert tagged not in by_id

    # Dry-run only: the live books are unchanged (still no series on the untagged ones).
    assert client.get(f"/api/books/{untagged1}").json()["series"] is None
    assert client.get(f"/api/books/{untagged2}").json()["series"] is None
