"""The shared current-date system note (app.agent.dates)."""

from __future__ import annotations

import datetime as dt

from app.agent import dates


def test_date_block_states_today_year_and_relative_rules() -> None:
    fixed = dt.datetime(2026, 11, 8, 10, 0, tzinfo=dt.timezone.utc)
    block = dates.date_system_block(fixed)
    assert "2026-11-08" in block
    assert "current year is 2026" in block
    # "this year" steers to finished_on in the current year, not a text search.
    assert "finished_on in 2026" in block
    # "last year" resolves to the previous year.
    assert "2025" in block
    # The agent must never ask the user which year it is.
    assert "NEVER ask the user what year it is" in block


def test_agui_context_starts_with_current_date() -> None:
    from app.agent.sessions import _with_date

    assert _with_date(None).startswith("- Current date: Today is ")
    merged = _with_date("- Visible tab: library")
    assert merged.splitlines()[1] == "- Visible tab: library"


def test_now_is_timezone_aware() -> None:
    assert dates.now().tzinfo is not None
