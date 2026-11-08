"""Tests for the wave-6 release-research rework.

Covers the two-agent research step (RESEARCHER + EDITOR, mocked model), the editor output
parsing/validation and garbage-title rejection, the service that stores the clean
ReleaseSummary into series_info, the language filter, the Google Books auto-add (mocked:
happy path, skipped when owned, 429 keeps a clean waiting-list entry) and the additive
migration. Zero live Bedrock / web / Google calls.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agent import series_research
from app.agent.series_research import ResearchResult, research_next_volumes, seed_queries
from app.db import SINGLE_USER_ID, connect
from app.schemas.books import VolumeSearchResult
from app.schemas.series import ReleaseDetail, ReleaseEdition, ReleaseSummary
from app.services import series_service


class _FakeModel:
    """Stands in for a strands Bedrock model; the Agent is built but never used here."""


def _editor_summary(**over: object) -> ReleaseSummary:
    base = dict(
        status="in_translation",
        headline="Fabryka Słów nie podała jeszcze daty 7. tomu (Ritual of Ruin); tłumaczenie trwa.",
        next_title="Ritual of Ruin",
        next_volume=7.0,
        expected_date="2026",
        details=[ReleaseDetail(text="Tłumaczenie w toku.", source_url="https://fabryka.pl/x")],
        editions={
            "pl": ReleaseEdition(
                status="in_translation", title="Ritual of Ruin", source_url="https://fabryka.pl/x"
            )
        },
    )
    base.update(over)
    return ReleaseSummary(**base)


def _patch_agents(
    monkeypatch: pytest.MonkeyPatch, *, editor_summary: ReleaseSummary, boom: bool = False
) -> list[str]:
    """Patch strands.Agent with a researcher (invoke_async) + editor (structured_output)."""
    calls: list[str] = []

    class _Agent:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self._has_tools = bool(kwargs.get("tools"))

        async def invoke_async(self, prompt):  # noqa: ANN001
            calls.append("research")
            if boom:
                raise RuntimeError("NoCredentials")
            return "brief: found Ritual of Ruin, vol 7, translation in progress"

        async def structured_output_async(self, model, prompt):  # noqa: ANN001
            calls.append("edit")
            if boom:
                raise RuntimeError("NoCredentials")
            return editor_summary

    monkeypatch.setattr("strands.Agent", _Agent)
    return calls


# --- agent-level: language filter, parsing, clamp -----------------------------------------


def test_seed_queries_respect_language() -> None:
    pl_only = seed_queries("King's Dark Tidings", "Kel Kade", [6], ["Kroniki Mroku"], ["pl"])
    assert all("Kroniki" in q or "premiera" in q for q in pl_only)
    assert not any("book" in q and "release" in q for q in pl_only)

    en_only = seed_queries("King's Dark Tidings", "Kel Kade", [6], ["Kroniki Mroku"], ["en"])
    assert any("release date" in q for q in en_only)

    both = seed_queries("King's Dark Tidings", "Kel Kade", [6], ["Kroniki Mroku"], ["pl", "en"])
    assert len(both) == 2


def test_research_only_searches_requested_language(monkeypatch: pytest.MonkeyPatch) -> None:
    """With search_lang='pl' the seed searches must not hit English retailer queries."""
    seen: list[str] = []

    def fake_search(query, *, budget=None):  # noqa: ANN001
        seen.append(query)
        return []

    monkeypatch.setattr(series_research.web_research, "web_search", fake_search)
    _patch_agents(monkeypatch, editor_summary=_editor_summary())
    asyncio.run(
        research_next_volumes(
            "King's Dark Tidings",
            "Kel Kade",
            [6],
            search_lang="pl",
            model=_FakeModel(),  # type: ignore[arg-type]
            aliases=["Kroniki Mroku"],
        )
    )
    assert seen, "seed search should have run"
    assert not any("release date" in q for q in seen)


def test_editor_output_parsed_and_projected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(series_research.web_research, "web_search", lambda q, **k: [])
    _patch_agents(monkeypatch, editor_summary=_editor_summary())
    result = asyncio.run(
        research_next_volumes(
            "King's Dark Tidings",
            "Kel Kade",
            [6],
            search_lang="pl",
            model=_FakeModel(),  # type: ignore[arg-type]
        )
    )
    assert result.summary.status == "in_translation"
    assert result.summary.next_title == "Ritual of Ruin"
    assert result.summary.next_volume == 7.0
    assert result.summary.checked_at
    # Legacy per-edition projection is filled for compatibility.
    assert result.pl.title == "Ritual of Ruin"


def test_editor_invalid_status_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(series_research.web_research, "web_search", lambda q, **k: [])
    _patch_agents(monkeypatch, editor_summary=_editor_summary(status="totally-made-up"))
    result = asyncio.run(
        research_next_volumes("S", "A", [1], model=_FakeModel())  # type: ignore[arg-type]
    )
    assert result.summary.status == "unknown"


def test_garbage_next_title_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A series-tagged title like the series name + 'tom 7' must be dropped."""
    monkeypatch.setattr(series_research.web_research, "web_search", lambda q, **k: [])
    _patch_agents(
        monkeypatch,
        editor_summary=_editor_summary(
            next_title="King's Dark Tidings (Kroniki mroku tom 7)",
            status="no_news",
            expected_date="unknown",
        ),
    )
    result = asyncio.run(
        research_next_volumes(
            "King's Dark Tidings",
            "Kel Kade",
            [6],
            model=_FakeModel(),  # type: ignore[arg-type]
            aliases=["Kroniki Mroku"],
        )
    )
    assert result.summary.next_title is None
    assert result.summary.expected_date is None


def test_research_failure_yields_all_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(series_research.web_research, "web_search", lambda q, **k: [])
    _patch_agents(monkeypatch, editor_summary=_editor_summary(), boom=True)
    result = asyncio.run(
        research_next_volumes("S", "A", [1], model=_FakeModel())  # type: ignore[arg-type]
    )
    assert result.summary.status == "unknown"
    assert result.summary.headline == ""
    assert result.pl.status == "unknown"


# --- service-level helpers ----------------------------------------------------------------


def _add(client: TestClient, **fields: object) -> int:
    payload = {"title": "T", "metadata_source": "manual", **fields}
    resp = client.post("/api/books", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _run_research(
    db_file: Path, key: str, summary: ReleaseSummary, *, user_data: object | None = None
) -> None:
    from app.userdata import UserData, using_user_data

    async def fake_research(name, author, owned):  # noqa: ANN001
        return ResearchResult(summary=summary)

    async def run() -> None:
        conn = await connect(db_file)
        try:
            await series_service.research_series_releases(
                SINGLE_USER_ID, key, conn=conn, research_fn=fake_research
            )
        finally:
            await conn.close()

    # The real path runs inside a request / captured background task that has user context;
    # mirror that so the books.json mirror (auto-add) can resolve the dataset path.
    ud = user_data or UserData.for_user(db_file.parent.parent.parent, SINGLE_USER_ID)
    with using_user_data(ud):  # type: ignore[arg-type]
        asyncio.run(run())


# --- service: stores clean summary, waiting list only with a real title -------------------


def test_service_stores_release_summary(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="SoP 6",
        series="Shroud",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    _run_research(db_file, key, _editor_summary(status="announced"))

    summary = client.get(f"/api/series/{key}").json()
    assert summary["checking"] is False
    rs = summary["release_summary"]
    assert rs["status"] == "announced"
    assert rs["next_title"] == "Ritual of Ruin"
    assert rs["next_volume"] == 7
    assert rs["headline"].startswith("Fabryka")


def test_waiting_list_only_with_real_title(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="NN 1",
        series="No News Series",
        volume="1",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    # A no-news summary without a real title -> no waiting-list entry.
    _run_research(
        db_file,
        key,
        _editor_summary(status="no_news", next_title=None, next_volume=None, expected_date=None),
    )
    assert client.get("/api/series/expected").json() == []

    # Now a real title arrives (but not released/announced, so no auto-add) -> one entry.
    _run_research(db_file, key, _editor_summary(status="in_translation"))
    expected = client.get("/api/series/expected").json()
    assert len(expected) == 1
    assert expected[0]["title"] == "Ritual of Ruin"
    assert expected[0]["source"] == "series_research"


def test_garbage_waiting_entries_deleted(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="G 1",
        series="Garbage Series",
        volume="1",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    # Seed an old wave-5 garbage researched entry (titleless-style, lang-tagged source).
    client.post(
        "/api/series/expected",
        json={
            "title": "Garbage Series (tom 2)",
            "series_name": "Garbage Series",
            "source": "series_research:pl",
        },
    )
    # A research run that finds no real title must wipe the old researched entry.
    _run_research(
        db_file,
        key,
        _editor_summary(status="no_news", next_title=None, next_volume=None, expected_date=None),
    )
    titles = {e["title"] for e in client.get("/api/series/expected").json()}
    assert "Garbage Series (tom 2)" not in titles


def test_manual_waiting_entry_survives(client: TestClient, db_file: Path) -> None:
    _add(
        client,
        title="KM 1",
        series="Keep Manual",
        volume="1",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    client.post(
        "/api/series/expected",
        json={
            "title": "My manual pick",
            "series_name": "Keep Manual",
            "source": "agent",
        },
    )
    _run_research(db_file, key, _editor_summary(status="in_translation"))
    titles = {e["title"] for e in client.get("/api/series/expected").json()}
    assert "My manual pick" in titles
    assert "Ritual of Ruin" in titles


# --- service: Google Books auto-add -------------------------------------------------------


def _patch_google(
    monkeypatch: pytest.MonkeyPatch, result: list[VolumeSearchResult] | Exception
) -> None:
    """Patch series_service._client to a fake Google Books client returning ``result``."""

    class _FakeGB:
        async def search(self, query, max_results=20, lang=None):  # noqa: ANN001
            if isinstance(result, Exception):
                raise result
            return len(result), list(result)

    monkeypatch.setattr(series_service, "_client", lambda settings=None: _FakeGB())


def test_auto_add_happy_path(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _add(
        client,
        title="AA 6",
        series="AutoAdd",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]

    hit = VolumeSearchResult(
        google_volume_id="vol-ritual",
        title="Ritual of Ruin",
        authors=["Kel Kade"],
        isbn_13="9781000000007",
    )
    _patch_google(monkeypatch, [hit])
    # Give the summary an author-matching series so the surname check passes.
    client.patch(f"/api/series/{key}", json={"author": "Kel Kade"})
    _run_research(db_file, key, _editor_summary(status="released"))

    # Book added to the library with status want, series + volume set.
    books = client.get("/api/books").json()
    added = [b for b in books if b["title"] == "Ritual of Ruin"]
    assert len(added) == 1
    assert added[0]["status"] == "want"
    assert added[0]["series"] == "AutoAdd"
    assert str(added[0]["volume"]) == "7"
    # release_summary.added_book_id set; no waiting-list entry (it is in the library now).
    rs = client.get(f"/api/series/{key}").json()["release_summary"]
    assert rs["added_book_id"] == added[0]["id"]
    assert client.get("/api/series/expected").json() == []


def test_auto_add_skipped_when_owned(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _add(
        client,
        title="Owned 6",
        series="OwnSeries",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    # Already owns volume 7.
    _add(client, title="Owned 7", series="OwnSeries", volume="7", status="want")
    key = client.get("/api/series").json()[0]["series_key"]

    called = {"n": 0}

    class _FakeGB:
        async def search(self, query, max_results=20, lang=None):  # noqa: ANN001
            called["n"] += 1
            return 0, []

    monkeypatch.setattr(series_service, "_client", lambda settings=None: _FakeGB())
    _run_research(db_file, key, _editor_summary(status="released"))
    # Owns vol 7 already -> no Google call, no new book.
    assert called["n"] == 0
    rs = client.get(f"/api/series/{key}").json()["release_summary"]
    assert rs["added_book_id"] is None


def test_auto_add_google_429_keeps_waiting_entry(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _add(
        client,
        title="Q 6",
        series="QuotaSeries",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]

    err = httpx.HTTPStatusError(
        "429",
        request=httpx.Request("GET", "http://x"),
        response=httpx.Response(429),
    )
    _patch_google(monkeypatch, err)
    _run_research(db_file, key, _editor_summary(status="released"))

    # Google is out (429, no retry): the book is still added from the title as 'want'
    # (no cover/metadata), and it is not also left on the waiting list.
    added = [b for b in client.get("/api/books").json() if b["title"] == "Ritual of Ruin"]
    assert len(added) == 1
    assert added[0]["status"] == "want"
    assert added[0]["google_volume_id"] is None
    assert client.get("/api/series/expected").json() == []


def test_auto_add_not_added_twice(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _add(
        client,
        title="Tw 6",
        series="TwiceSeries",
        volume="6",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    hit = VolumeSearchResult(
        google_volume_id="vol-twice",
        title="Ritual of Ruin",
        authors=["Kel Kade"],
    )
    _patch_google(monkeypatch, [hit])
    client.patch(f"/api/series/{key}", json={"author": "Kel Kade"})
    _run_research(db_file, key, _editor_summary(status="released"))
    _run_research(db_file, key, _editor_summary(status="released"))
    added = [b for b in client.get("/api/books").json() if b["title"] == "Ritual of Ruin"]
    assert len(added) == 1


# --- API: search_lang contract ------------------------------------------------------------


def test_patch_accepts_search_lang(client: TestClient) -> None:
    _add(
        client,
        title="L 1",
        series="LangSeries",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    resp = client.patch(f"/api/series/{key}", json={"search_lang": "en"})
    assert resp.status_code == 200
    assert resp.json()["search_lang"] == "en"


def test_preferences_default_search_lang(client: TestClient) -> None:
    # Default is 'pl'.
    assert client.get("/api/preferences/series").json()["default_search_lang"] == "pl"
    client.put("/api/preferences/series", json={"filter": "all", "default_search_lang": "both"})
    assert client.get("/api/preferences/series").json()["default_search_lang"] == "both"


def test_newly_watched_series_takes_default_lang(client: TestClient) -> None:
    client.put("/api/preferences/series", json={"filter": "all", "default_search_lang": "en"})
    _add(
        client,
        title="W 1",
        series="WatchLang",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    client.patch(f"/api/series/{key}", json={"watch": True})
    assert client.get(f"/api/series/{key}").json()["search_lang"] == "en"


def test_refresh_accepts_search_lang_override(client: TestClient) -> None:
    _add(
        client,
        title="R 1",
        series="RefreshLang",
        volume="1",
        status="finished",
        finished_on="2021-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    resp = client.post(f"/api/series/{key}/refresh", json={"search_lang": "both"})
    assert resp.status_code == 200
    # The override is saved to the series.
    assert client.get(f"/api/series/{key}").json()["search_lang"] == "both"


# --- migration keeps data -----------------------------------------------------------------


def test_migration_adds_columns_and_keeps_data(tmp_path: Path) -> None:
    """An older series_info table (no search_lang/release_summary) migrates without loss."""
    import aiosqlite

    from app.db import init_db

    db = tmp_path / "old.sqlite"

    async def build_old() -> None:
        # Create a minimal older schema missing the wave-6 columns, with one data row.
        async with aiosqlite.connect(db) as conn:
            await conn.executescript(
                """
                CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT);
                CREATE TABLE series_info (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    series_key TEXT NOT NULL,
                    display_name TEXT NOT NULL DEFAULT '',
                    author TEXT NOT NULL DEFAULT '',
                    aliases TEXT NOT NULL DEFAULT '[]',
                    known_volumes TEXT NOT NULL DEFAULT '[]',
                    total_known INTEGER,
                    watch INTEGER NOT NULL DEFAULT 0,
                    next_expected TEXT,
                    notes TEXT,
                    last_checked TEXT,
                    created_at TEXT, updated_at TEXT,
                    UNIQUE (user_id, series_key)
                );
                INSERT INTO users (id, display_name) VALUES (1, 'U');
                INSERT INTO series_info (user_id, series_key, display_name, watch)
                    VALUES (1, 'kept', 'Kept Series', 1);
                """
            )
            await conn.commit()

    asyncio.run(build_old())
    # init_db runs the additive migration on the existing file.
    asyncio.run(init_db(db))

    async def check() -> None:
        conn = await connect(db)
        try:
            cursor = await conn.execute("PRAGMA table_info(series_info)")
            cols = {row[1] for row in await cursor.fetchall()}
            assert "search_lang" in cols and "release_summary" in cols
            cursor = await conn.execute(
                "SELECT display_name, watch, search_lang FROM series_info WHERE series_key='kept'"
            )
            row = await cursor.fetchone()
            assert row is not None
            assert row[0] == "Kept Series"
            assert row[1] == 1
            assert row[2] == "pl"  # new column default applied
        finally:
            await conn.close()

    asyncio.run(check())


def test_found_missing_volume_auto_added(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A gap (#1 missing, own #2 and #3) found by research is added as 'want' (auto mode)."""
    for vol in ("2", "3"):
        _add(
            client,
            title=f"Gap {vol}",
            series="GapSeries",
            volume=vol,
            status="finished",
            finished_on="2024-01-01",
        )
    key = client.get("/api/series").json()[0]["series_key"]
    client.patch(f"/api/series/{key}", json={"author": "Kel Kade"})
    _patch_google(monkeypatch, [])  # Google has nothing -> added from the title

    from app.schemas.series import FoundVolume

    summary = _editor_summary(status="no_news")
    summary.next_title = None
    summary.next_volume = None
    summary.found_volumes = [
        FoundVolume(volume=1, title="Cmentarz grozy", status="released", date="2023"),
        FoundVolume(volume=2, title="Gap 2", status="released"),  # owned -> dropped
    ]
    _run_research(db_file, key, summary)

    books = client.get("/api/books").json()
    added = [b for b in books if b["title"] == "Cmentarz grozy"]
    assert len(added) == 1
    assert added[0]["status"] == "want"
    assert str(added[0]["volume"]) == "1"
    rs = client.get(f"/api/series/{key}").json()["release_summary"]
    assert [fv["volume"] for fv in rs["found_volumes"]] == [1.0]
    assert rs["found_volumes"][0]["added_book_id"] == added[0]["id"]


def test_ask_mode_does_not_add_until_clicked(
    client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _add(
        client,
        title="Ask 2",
        series="AskSeries",
        volume="2",
        status="finished",
        finished_on="2024-01-01",
    )
    key = client.get("/api/series").json()[0]["series_key"]
    resp = client.put("/api/preferences/series", json={"filter": "all", "add_mode": "ask"})
    assert resp.json()["add_mode"] == "ask"
    _patch_google(monkeypatch, [])

    from app.schemas.series import FoundVolume

    summary = _editor_summary(status="no_news")
    summary.next_title = None
    summary.next_volume = None
    summary.found_volumes = [FoundVolume(volume=1, title="Ask One", status="released")]
    _run_research(db_file, key, summary)

    assert not [b for b in client.get("/api/books").json() if b["title"] == "Ask One"]
    rs = client.get(f"/api/series/{key}").json()["release_summary"]
    assert rs["found_volumes"][0]["added_book_id"] is None

    # The card's Add button.
    resp = client.post(f"/api/series/{key}/volumes", json={"title": "Ask One", "volume": 1})
    assert resp.status_code == 200
    added = [b for b in client.get("/api/books").json() if b["title"] == "Ask One"]
    assert len(added) == 1 and added[0]["status"] == "want"
    assert resp.json()["release_summary"]["found_volumes"][0]["added_book_id"] == added[0]["id"]
