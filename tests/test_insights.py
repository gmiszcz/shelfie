"""Insights end-to-end: DB round-trip, PATCH edit, /enrich endpoint and full-text search."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent import tools
from app.config import Settings
from app.schemas.books import BookInsights
from app.services import books as books_service
from app.services import enrichment

SAMPLE_INSIGHTS = {
    "summary": "A warded man fights demons.",
    "main_characters": "Arlen, Leesha, Rojer",
    "main_plot": "Humanity hides from demons that rise each night.",
    "setting": "A medieval world besieged after dark",
    "themes": "fear, courage",
    "tone": "dark",
    "generated_at": "2026-11-06T00:00:00+00:00",
    "source": "agent",
}


@pytest.fixture(autouse=True)
def _no_background_enrichment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the add-book background task from making a real Bedrock call in tests."""
    monkeypatch.setattr(books_service, "schedule_enrichment", lambda *a, **k: None)


def test_insights_round_trip_through_api(client: TestClient) -> None:
    created = client.post(
        "/api/books",
        json={
            "title": "The Painted Man",
            "authors": ["Peter V. Brett"],
            "insights": SAMPLE_INSIGHTS,
        },
    ).json()
    fetched = client.get(f"/api/books/{created['id']}").json()
    assert fetched["insights"]["main_characters"] == "Arlen, Leesha, Rojer"
    assert fetched["insights"]["source"] == "agent"


def test_user_can_edit_insights_via_patch(client: TestClient) -> None:
    book_id = client.post("/api/books", json={"title": "Edit Me"}).json()["id"]
    edited = dict(SAMPLE_INSIGHTS, summary="User-written summary", source="user")
    resp = client.patch(f"/api/books/{book_id}", json={"insights": edited})
    assert resp.status_code == 200
    assert resp.json()["insights"]["summary"] == "User-written summary"
    assert resp.json()["insights"]["source"] == "user"


def test_insights_can_be_cleared(client: TestClient) -> None:
    book_id = client.post(
        "/api/books", json={"title": "Has Insights", "insights": SAMPLE_INSIGHTS}
    ).json()["id"]
    resp = client.patch(f"/api/books/{book_id}", json={"insights": None})
    assert resp.status_code == 200
    assert resp.json()["insights"] is None


def test_enrich_endpoint_persists_generated_insights(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, db_file: Path
) -> None:
    book_id = client.post("/api/books", json={"title": "Dune"}).json()["id"]

    async def fake_generate(book: object, *, settings: object | None = None) -> BookInsights:
        return BookInsights(summary="A desert epic.", source="agent", generated_at="2026-01-01")

    monkeypatch.setattr(enrichment, "generate_insights", fake_generate)
    # enrich_book opens its own connection against the configured db; point it at the test db.
    monkeypatch.setattr(books_service, "get_settings", lambda: Settings(db_path=str(db_file)))

    resp = client.post(f"/api/books/{book_id}/enrich")
    assert resp.status_code == 200
    assert resp.json()["insights"]["summary"] == "A desert epic."

    # Persisted, not just returned.
    assert client.get(f"/api/books/{book_id}").json()["insights"]["summary"] == "A desert epic."


def test_enrich_missing_book_404(client: TestClient) -> None:
    assert client.post("/api/books/999/enrich").status_code == 404


def test_search_finds_text_in_description_and_insights(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, db_file: Path
) -> None:
    # A book whose Arlen reference lives only in the description, not the title/authors.
    client.post(
        "/api/books",
        json={
            "title": "The Painted Man",
            "authors": ["Peter V. Brett"],
            "description": "The story of Arlen Bales, who becomes the Warded Man.",
            "google_volume_id": "pm-1",
        },
    )
    # A book whose match lives only in insights.
    client.post(
        "/api/books",
        json={
            "title": "Mystery Volume",
            "insights": {"themes": "obscurewardtoken courage", "source": "agent"},
            "google_volume_id": "mv-1",
        },
    )
    monkeypatch.setattr(tools, "get_settings", lambda: Settings(db_path=str(db_file)))

    arlen = tools.search_library(query="Arlen")
    assert arlen["count"] == 1
    assert arlen["books"][0]["title"] == "The Painted Man"

    by_insight = tools.search_library(query="obscurewardtoken")
    assert by_insight["count"] == 1
    assert by_insight["books"][0]["title"] == "Mystery Volume"


def test_get_book_tool_returns_insights(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, db_file: Path
) -> None:
    book_id = client.post(
        "/api/books", json={"title": "Full Detail", "insights": SAMPLE_INSIGHTS}
    ).json()["id"]
    monkeypatch.setattr(tools, "get_settings", lambda: Settings(db_path=str(db_file)))
    detail = tools.get_book(book_id=book_id)
    assert detail["title"] == "Full Detail"
    assert detail["insights"]["main_characters"] == "Arlen, Leesha, Rojer"
