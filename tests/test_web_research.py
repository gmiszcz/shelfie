"""Tests for the web-research primitives: DDG parsing, disk cache, call budget."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings
from app.integrations import web_research
from app.integrations.web_research import CallBudget, parse_ddg_html, readable_text


@pytest.fixture
def web_cache(tmp_path: Path):
    settings = get_settings()
    original = settings.web_cache_dir
    settings.web_cache_dir = str(tmp_path / "web")
    yield tmp_path / "web"
    settings.web_cache_dir = original


_DDG_SAMPLE = """
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkelkade.com%2Fbooks%2Fritual-of-ruin">
    Ritual of Ruin — K. E. Kelkade
  </a>
  <a class="result__snippet">Book 7 of Shroud of Prophecy, released 11 November 2025.</a>
</div>
<div class="result">
  <a class="result__a" href="https://lubimyczytac.pl/ksiazka/123/tom">Kroniki Mroku tom 7</a>
  <a class="result__snippet">Brak informacji o dacie wydania.</a>
</div>
"""


def test_parse_ddg_unwraps_redirect_and_extracts_snippet() -> None:
    results = parse_ddg_html(_DDG_SAMPLE)
    assert len(results) == 2
    assert results[0]["url"] == "https://kelkade.com/books/ritual-of-ruin"
    assert "Ritual of Ruin" in results[0]["title"]
    assert "11 November 2025" in results[0]["snippet"]
    assert results[1]["url"].startswith("https://lubimyczytac.pl/")


def test_parse_ddg_caps_at_eight() -> None:
    block = _DDG_SAMPLE * 10
    assert len(parse_ddg_html(block)) <= 8


def test_readable_text_strips_tags_and_caps() -> None:
    html = (
        "<html><head><style>x{}</style></head><body><h1>Hi</h1><p>Body "
        + "a" * 9000
        + "</p></body></html>"
    )
    text = readable_text(html, cap=100)
    assert "Hi" in text
    assert "x{}" not in text
    assert len(text) <= 100


def test_web_search_uses_cache_and_budget(monkeypatch: pytest.MonkeyPatch, web_cache: Path) -> None:
    calls = {"n": 0}

    class _Resp:
        text = _DDG_SAMPLE

        def raise_for_status(self) -> None:
            return None

    def fake_post(*args: object, **kwargs: object) -> _Resp:
        calls["n"] += 1
        return _Resp()

    monkeypatch.setattr(web_research.httpx, "post", fake_post)
    budget = CallBudget(5)

    first = web_research.web_search("Shroud of Prophecy book 7", budget=budget)
    assert len(first) == 2
    assert calls["n"] == 1
    assert budget.used == 1

    # Second identical query hits the on-disk cache: no new HTTP call, no budget spent.
    second = web_research.web_search("Shroud of Prophecy book 7", budget=budget)
    assert second == first
    assert calls["n"] == 1
    assert budget.used == 1


def test_budget_refuses_when_spent(monkeypatch: pytest.MonkeyPatch, web_cache: Path) -> None:
    def fake_get(*args: object, **kwargs: object):
        raise AssertionError("should not be called when budget is spent")

    monkeypatch.setattr(web_research.httpx, "get", fake_get)
    budget = CallBudget(0)
    assert web_research.fetch_url("https://example.com/x", budget=budget) == ""


def test_fetch_url_rejects_non_http(web_cache: Path) -> None:
    assert web_research.fetch_url("ftp://nope", budget=CallBudget(3)) == ""
