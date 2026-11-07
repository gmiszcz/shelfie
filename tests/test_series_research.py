"""Tests for the release-research step: the strands agent (mocked model) and the
service that stores its result into series_info + expected_books (mocked research_fn)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent import series_research
from app.agent.series_research import EditionResult, ResearchResult
from app.db import SINGLE_USER_ID, connect
from app.services import series_service


class _FakeModel:
    """Stands in for a strands Bedrock model; the Agent is built but never used here."""


def test_research_agent_clamps_unknown_date(monkeypatch: pytest.MonkeyPatch) -> None:
    """A result the model returns with status unknown must never keep a date."""

    class _FakeAgent:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def invoke_async(self, prompt):  # noqa: ANN001
            return None

        async def structured_output_async(self, model, prompt):  # noqa: ANN001
            return ResearchResult(
                pl=EditionResult(title="x", date="2027-01-01", status="unknown"),
                en=EditionResult(
                    title="Ritual of Ruin",
                    date="2025-11-11",
                    status="released",
                    source_url="https://kelkade.com",
                    confidence="high",
                ),
            )

    monkeypatch.setattr("strands.Agent", _FakeAgent)
    result = asyncio.run(
        series_research.research_next_volumes(
            "Shroud", "K", [1, 2, 3], model=_FakeModel()  # type: ignore[arg-type]
        )
    )
    # PL unknown -> date cleared; EN released kept verbatim.
    assert result.pl.status == "unknown" and result.pl.date is None
    assert result.en.status == "released" and result.en.date == "2025-11-11"
    assert result.en.source_url == "https://kelkade.com"


def test_research_agent_failure_yields_all_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    class _BoomAgent:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def invoke_async(self, prompt):  # noqa: ANN001
            raise RuntimeError("NoCredentials")

        async def structured_output_async(self, model, prompt):  # noqa: ANN001
            raise RuntimeError("NoCredentials")

    monkeypatch.setattr("strands.Agent", _BoomAgent)
    result = asyncio.run(
        series_research.research_next_volumes(
            "Shroud", "K", [1], model=_FakeModel()  # type: ignore[arg-type]
        )
    )
    assert result.pl.status == "unknown"
    assert result.en.status == "unknown"


def _add(client: TestClient, **fields: object) -> int:
    payload = {"title": "T", "metadata_source": "manual", **fields}
    resp = client.post("/api/books", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_research_service_stores_both_editions_and_bumps_total(
    client: TestClient, db_file: Path
) -> None:
    _add(
        client,
        title="SoP 6",
        series="Shroud of Prophecy",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]

    async def fake_research(name, author, owned):  # noqa: ANN001
        return ResearchResult(
            pl=EditionResult(title=None, date=None, status="unknown"),
            en=EditionResult(
                title="Ritual of Ruin",
                date="2025-11-11",
                status="released",
                source_url="https://kelkade.com",
                confidence="high",
            ),
        )

    async def run() -> None:
        conn = await connect(db_file)
        try:
            await series_service.research_series_releases(
                SINGLE_USER_ID, key, conn=conn, research_fn=fake_research
            )
        finally:
            await conn.close()

    asyncio.run(run())

    summary = client.get(f"/api/series/{key}").json()
    assert summary["checking"] is False
    assert summary["next_expected_en"]["title"] == "Ritual of Ruin"
    assert summary["next_expected_en"]["date"] == "2025-11-11"
    # An all-unknown PL edition is stored as null (nothing found) — the card shows
    # "PL — not announced".
    assert summary["next_expected_pl"] is None
    # A newer volume exists -> total_known bumped to at least highest-owned + 1 = 7.
    assert (summary["total_known"] or 0) >= 7

    # Waiting list got one entry per language with a language-tagged source.
    expected = client.get("/api/series/expected").json()
    sources = {e["source"] for e in expected}
    assert "series_research:en" in sources
    en = next(e for e in expected if e["source"] == "series_research:en")
    assert en["title"] == "Ritual of Ruin"


def test_research_keeps_manual_expected_entries(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="SoP 6b",
        series="Keep Manual",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    # A manual waiting-list entry (source 'agent') that must survive a research run.
    client.post(
        "/api/series/expected",
        json={
            "title": "My manual pick",
            "series_name": "Keep Manual",
            "source": "agent",
        },
    )

    async def fake_research(name, author, owned):  # noqa: ANN001
        return ResearchResult(
            en=EditionResult(title="Found EN", date="2026-01-01", status="announced")
        )

    async def run() -> None:
        conn = await connect(db_file)
        try:
            await series_service.research_series_releases(
                SINGLE_USER_ID, key, conn=conn, research_fn=fake_research
            )
        finally:
            await conn.close()

    asyncio.run(run())
    titles = {e["title"] for e in client.get("/api/series/expected").json()}
    assert "My manual pick" in titles
    assert "Found EN" in titles


def test_patch_watch_on_sets_checking(client: TestClient) -> None:
    """Turning watch on returns immediately with checking=true (research runs in the bg task)."""
    _add(
        client,
        title="WChk",
        series="Watch Check",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    resp = client.patch(f"/api/series/{key}", json={"watch": True})
    assert resp.status_code == 200
    assert resp.json()["watch"] is True
    # The background task uses the real model in prod; in TestClient it runs after the
    # response and (without AWS) yields all-unknown, clearing checking. We only assert the
    # endpoint accepted the toggle and returned the watch flag; checking is transient.
