"""Frontend ("UI") tool stubs (app.agent.ui_tools)."""

from __future__ import annotations

from app.agent import ui_tools


def test_filter_library_builds_detail_with_only_set_facets() -> None:
    out = ui_tools.filter_library(series="Droga Szamana")
    assert out["ok"] is True
    assert out["ui_action"] == {"action": "filter_library", "series": "Droga Szamana"}


def test_filter_library_trims_and_lowercases_status_and_keeps_min_stars() -> None:
    out = ui_tools.filter_library(status="  Finished ", min_stars=4.5)
    detail = out["ui_action"]
    assert detail["status"] == "finished"
    assert detail["min_stars"] == 4.5
    # Empty / zero facets are omitted.
    assert "query" not in detail and "shelf" not in detail


def test_clear_filter() -> None:
    assert ui_tools.clear_filter()["ui_action"] == {"action": "clear_filter"}


def test_navigate_valid_and_invalid() -> None:
    assert ui_tools.navigate("stats")["ui_action"] == {"action": "navigate", "tab": "stats"}
    assert "error" in ui_tools.navigate("nope")


def test_open_book_coerces_int() -> None:
    assert ui_tools.open_book(book_id=42)["ui_action"] == {"action": "open_book", "book_id": 42}


def test_ui_tools_list_is_the_four_tools() -> None:
    assert len(ui_tools.UI_TOOLS) == 4
