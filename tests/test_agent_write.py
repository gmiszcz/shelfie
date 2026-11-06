"""Write-tool tests for the library assistant (app.agent.tools).

These exercise add_book, update_book, set_insights and delete_book against an isolated
temp DB, plus the human-in-the-loop confirmation gate for delete_book and bulk updates.
No Bedrock and no network: the Google Books lookup is replaced by a canned best match.
Each write tool drives the async service with ``asyncio.run`` internally, so every test
here is a plain synchronous function (calling it from inside a running loop would fail).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent import tools
from app.config import Settings
from app.schemas.books import VolumeSearchResult


@pytest.fixture
def write_db(client: TestClient, db_file: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the agent tools at the isolated temp DB used by the ``client`` fixture."""
    monkeypatch.setattr(tools, "get_settings", lambda: Settings(db_path=str(db_file)))
    return db_file


def _seed(client: TestClient, **fields: object) -> int:
    body = {"title": "Seed", "authors": ["A"], "status": "want", **fields}
    resp = client.post("/api/books", json=body)
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


# --- add_book ---------------------------------------------------------------------------


def test_add_book_manual(write_db: Path) -> None:
    out = tools.add_book(
        title="Diuna",
        authors="Frank Herbert",
        status="finished",
        stars=4.5,
        finished_on="2023-01-01",
    )
    assert out["ok"] is True
    added = out["added"]
    assert added["title"] == "Diuna"
    assert added["authors"] == ["Frank Herbert"]
    assert added["status"] == "finished"
    assert added["stars"] == 4.5
    assert added["finished_on"] == "2023-01-01"

    # It is really in the DB and readable through the read tools.
    assert tools.search_library(query="diuna")["count"] == 1


def test_add_book_manual_requires_title(write_db: Path) -> None:
    out = tools.add_book(authors="Nobody")
    assert "error" in out and "title" in out["error"]


def test_add_book_from_search_uses_best_match(
    write_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_best_match(query: str) -> VolumeSearchResult:
        return VolumeSearchResult(
            google_volume_id="vol-dune",
            title="Dune",
            authors=["Frank Herbert"],
            published_date="1965",
            description="Desert planet epic.",
            isbn_13="9780441013593",
            cover_url="https://example.test/dune.jpg",
        )

    monkeypatch.setattr(tools, "_search_best_match", fake_best_match)
    out = tools.add_book(query="dune herbert", status="finished", stars=5)
    assert out["ok"] is True
    added = out["added"]
    assert added["title"] == "Dune"
    assert added["authors"] == ["Frank Herbert"]
    # Reading fields the user gave win over / extend the catalogue match.
    assert added["status"] == "finished" and added["stars"] == 5
    assert out["matched_from_search"]["title"] == "Dune"
    # Full detail carries the catalogue metadata from the match.
    detail = tools.get_book_details(book_id=added["id"])
    assert detail["isbn_13"] == "9780441013593"
    assert detail["metadata_source"] == "google_books"


def test_add_book_from_search_no_match(write_db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def none_match(query: str) -> None:
        return None

    monkeypatch.setattr(tools, "_search_best_match", none_match)
    out = tools.add_book(query="zzz nonexistent")
    assert "error" in out and "no Google Books match" in out["error"]


# --- update_book ------------------------------------------------------------------------


def test_update_single_book_applies_immediately(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client)
    out = tools.update_book(book_id=book_id, status="finished", stars=4.5, finished_on="2023-05-01")
    assert out["ok"] is True and out["updated_count"] == 1
    detail = tools.get_book_details(book_id=book_id)
    assert detail["status"] == "finished"
    assert detail["stars"] == 4.5
    assert detail["finished_on"] == "2023-05-01"


def test_update_replaces_shelves_and_tags(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client, shelves=["Old"], tags=["x"])
    tools.update_book(book_id=book_id, shelves="Fantasy, Sci-Fi", tags="favourite")
    detail = tools.get_book_details(book_id=book_id)
    assert detail["shelves"] == ["Fantasy", "Sci-Fi"]
    assert detail["tags"] == ["favourite"]


def test_update_rejects_non_half_step_stars(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client)
    out = tools.update_book(book_id=book_id, stars=4.3)
    assert "error" in out


def test_update_needs_something_to_change(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client)
    out = tools.update_book(book_id=book_id)
    assert "error" in out and "nothing to update" in out["error"]


def test_bulk_update_needs_confirmation_then_applies(write_db: Path, client: TestClient) -> None:
    ids = [_seed(client) for _ in range(4)]
    csv = ",".join(str(i) for i in ids)

    # First call: more than 3 books -> needs_confirmation, nothing changed.
    gate = tools.update_book(book_ids=csv, status="finished")
    assert gate["needs_confirmation"] is True
    assert gate["count"] == 4 and gate["book_ids"] == ids
    assert gate["changes"] == {"status": "finished"}
    # Unchanged until confirmed.
    assert tools.get_book_details(book_id=ids[0])["status"] == "want"

    # Second call with confirm=True applies to all.
    done = tools.update_book(book_ids=csv, status="finished", confirm=True)
    assert done["ok"] is True and done["updated_count"] == 4
    assert all(tools.get_book_details(book_id=i)["status"] == "finished" for i in ids)


def test_bulk_update_of_three_or_fewer_applies_without_confirmation(
    write_db: Path, client: TestClient
) -> None:
    ids = [_seed(client) for _ in range(3)]
    csv = ",".join(str(i) for i in ids)
    out = tools.update_book(book_ids=csv, status="reading")
    assert out["ok"] is True and out["updated_count"] == 3


# --- set_insights -----------------------------------------------------------------------


def test_set_insights(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client)
    out = tools.set_insights(
        book_id=book_id,
        summary="A boy and a desert.",
        themes="power, ecology",
    )
    assert out["ok"] is True
    ins = out["insights"]
    assert ins["summary"] == "A boy and a desert."
    assert ins["themes"] == "power, ecology"
    assert ins["main_characters"] is None
    assert ins["source"] == "agent" and ins["generated_at"]
    # Persisted.
    detail = tools.get_book_details(book_id=book_id)
    assert detail["insights"]["summary"] == "A boy and a desert."


def test_set_insights_missing_book(write_db: Path) -> None:
    assert "error" in tools.set_insights(book_id=999, summary="x")


# --- delete_book ------------------------------------------------------------------------


def test_delete_book_needs_confirmation_then_deletes(write_db: Path, client: TestClient) -> None:
    book_id = _seed(client, title="Doomed")

    # First call: no confirm -> needs_confirmation, book still present.
    gate = tools.delete_book(book_id=book_id)
    assert gate["needs_confirmation"] is True
    assert gate["book_id"] == book_id and gate["title"] == "Doomed"
    assert tools.get_book_details(book_id=book_id)["title"] == "Doomed"

    # Second call with confirm=True removes it.
    done = tools.delete_book(book_id=book_id, confirm=True)
    assert done["ok"] is True and done["deleted_id"] == book_id
    assert "error" in tools.get_book_details(book_id=book_id)


def test_delete_missing_book(write_db: Path) -> None:
    assert "error" in tools.delete_book(book_id=999, confirm=True)


# --- star-band helper -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("score", "band", "expected"),
    [
        (5.0, 5, True),
        (4.6, 5, True),
        (4.5, 5, False),  # 4.5 belongs to band 4, not 5
        (4.5, 4, True),
        (3.6, 4, True),
        (3.5, 4, False),
        (1.5, 1, True),
        (0.0, 1, True),
        (1.6, 1, False),
        (2.0, 2, True),
        (2.6, 2, False),
    ],
)
def test_in_star_band_boundaries(score: float, band: int, expected: bool) -> None:
    from app.schemas.books import Book

    book = Book(
        id=1,
        title="x",
        status="finished",
        stars=None,
        display_score=score,
        added_at="",
        updated_at="",
    )
    assert tools._in_star_band(book, band) is expected
