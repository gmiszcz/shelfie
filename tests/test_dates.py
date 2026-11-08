"""The shared current-date system note (app.agent.dates)."""

from __future__ import annotations

import datetime as dt

from app.agent import dates, ui_agent


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


def test_ui_date_block_reuses_shared_base_and_adds_ui_tail() -> None:
    fixed = dt.datetime(2026, 11, 8, 10, 0, tzinfo=dt.timezone.utc)
    ui_block = ui_agent._date_system_block(fixed)
    # Shares the exact wording of the shared base note.
    assert dates.date_system_block(fixed) in ui_block
    # Plus the UI-specific tail (use structured filters, not a free-text year).
    assert "structured library filters" in ui_block
    assert "przeczytane w 2026" in ui_block


def test_now_is_timezone_aware() -> None:
    assert dates.now().tzinfo is not None
