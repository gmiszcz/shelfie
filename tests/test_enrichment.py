"""Enrichment service and script tests — no Bedrock, no network.

A fake ``Agent`` is injected by monkeypatching ``strands.Agent``; ``generate_insights`` imports
it lazily, so the patch takes effect. Failures (raised, or bad structured output) must leave
insights ``None``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.config import Settings
from app.schemas.books import BookCreate, BookInsights
from app.services import enrichment
from scripts import enrich as enrich_script


class _FakeAgent:
    """Records the system prompt and prompt, returns a canned structured output."""

    last_system_prompt: str = ""
    last_prompt: str = ""
    output: Any = None
    raise_exc: Exception | None = None

    def __init__(self, *, model: Any, system_prompt: str, callback_handler: Any) -> None:
        type(self).last_system_prompt = system_prompt

    async def structured_output_async(self, output_model: type, prompt: str) -> Any:
        type(self).last_prompt = prompt
        exc = type(self).raise_exc
        if exc is not None:
            raise exc
        return type(self).output


@pytest.fixture
def fake_agent(monkeypatch: pytest.MonkeyPatch) -> type[_FakeAgent]:
    import strands

    _FakeAgent.raise_exc = None
    _FakeAgent.output = enrichment._GeneratedInsights(
        summary="A desert epic.",
        main_characters="Paul, Jessica",
        main_plot="A noble house takes a desert planet.",
        setting="Arrakis, the far future",
        themes="power, ecology",
        tone="epic",
    )
    monkeypatch.setattr(strands, "Agent", _FakeAgent)
    # Avoid building a real Bedrock model.
    monkeypatch.setattr(enrichment, "_build_model", lambda settings: object())
    return _FakeAgent


def test_language_name_maps_known_and_falls_back() -> None:
    assert enrichment.language_name("pl") == "Polish"
    assert enrichment.language_name("PL") == "Polish"
    assert enrichment.language_name("en-US") == "English"
    assert enrichment.language_name(None) == "English"
    assert enrichment.language_name("xx") == "English"


async def test_generate_insights_returns_validated_block(fake_agent: type[_FakeAgent]) -> None:
    book = BookCreate(title="Dune", authors=["Frank Herbert"], description="Desert planet epic.")
    result = await enrichment.generate_insights(book, settings=Settings())
    assert isinstance(result, BookInsights)
    assert result.summary == "A desert epic."
    assert result.source == "agent"
    assert result.generated_at is not None


async def test_polish_book_prompts_in_polish(fake_agent: type[_FakeAgent]) -> None:
    book = BookCreate(title="Droga Szamana", authors=["Wasilij Machanienko"], language="pl")
    await enrichment.generate_insights(book, settings=Settings())
    assert "Polish" in fake_agent.last_system_prompt
    assert "Droga Szamana" in fake_agent.last_prompt


async def test_generate_insights_none_on_model_error(fake_agent: type[_FakeAgent]) -> None:
    fake_agent.raise_exc = RuntimeError("bedrock down")
    book = BookCreate(title="Dune", authors=["Frank Herbert"])
    assert await enrichment.generate_insights(book, settings=Settings()) is None


async def test_generate_insights_none_on_empty_title(fake_agent: type[_FakeAgent]) -> None:
    # An empty title is rejected by BookCreate, so build a minimal stand-in instead.
    book = BookCreate(title="x", authors=[])
    book.title = ""
    assert await enrichment.generate_insights(book, settings=Settings()) is None


# --- script ------------------------------------------------------------------------------


def test_needs_insights_detects_missing_and_empty() -> None:
    assert enrich_script._needs_insights({}, force=False) is True
    assert enrich_script._needs_insights({"insights": None}, force=False) is True
    assert (
        enrich_script._needs_insights(
            {"insights": {"generated_at": "x", "source": "agent"}}, force=False
        )
        is True
    )
    assert enrich_script._needs_insights({"insights": {"summary": "a"}}, force=False) is False
    # force overrides a filled block.
    assert enrich_script._needs_insights({"insights": {"summary": "a"}}, force=True) is True


async def test_script_fills_only_missing_and_writes_atomically(
    tmp_path: Path, fake_agent: type[_FakeAgent]
) -> None:
    path = tmp_path / "books.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "books": [
                    {"title": "Dune", "authors": ["Frank Herbert"]},
                    {"title": "Already", "insights": {"summary": "kept"}},
                ],
            }
        ),
        encoding="utf-8",
    )
    rc = await enrich_script.run(path, force=False, limit=None, fill_description=True)
    assert rc == 0
    data = json.loads(path.read_text(encoding="utf-8"))
    first, second = data["books"]
    assert first["insights"]["summary"] == "A desert epic."
    assert first["insights"]["source"] == "agent"
    assert first["description"] == "A desert epic."  # filled from summary
    assert second["insights"] == {"summary": "kept"}  # untouched


async def test_script_limit_caps_work(tmp_path: Path, fake_agent: type[_FakeAgent]) -> None:
    path = tmp_path / "books.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "books": [
                    {"title": "One", "authors": []},
                    {"title": "Two", "authors": []},
                ],
            }
        ),
        encoding="utf-8",
    )
    await enrich_script.run(path, force=False, limit=1, fill_description=False)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data["books"][0]["insights"], dict)
    assert data["books"][1].get("insights") is None
