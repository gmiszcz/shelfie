"""AG-UI event-name mapping (app.agent.agui)."""

from __future__ import annotations

from app.agent import agui


def _one(event: dict) -> dict:
    out = list(agui.annotate(event))
    assert len(out) == 1
    return out[0]


def test_session_start_maps_to_run_started() -> None:
    assert _one({"type": "session_start", "session_id": "s1"})["agui"] == agui.RUN_STARTED


def test_token_and_reasoning_map() -> None:
    assert _one({"type": "token", "text": "hi"})["agui"] == agui.TEXT_MESSAGE_CONTENT
    assert _one({"type": "reasoning", "text": "x"})["agui"] == agui.THINKING_TEXT_MESSAGE_CONTENT


def test_tool_start_expands_to_start_then_args() -> None:
    frames = list(
        agui.annotate(
            {"type": "tool_start", "id": "t1", "name": "search_library", "input": {"query": "Dune"}}
        )
    )
    assert [f["agui"] for f in frames] == [agui.TOOL_CALL_START, agui.TOOL_CALL_ARGS]
    assert frames[0]["ui_action"] is False
    assert frames[1]["input"] == {"query": "Dune"}


def test_ui_tool_start_is_flagged() -> None:
    frames = list(
        agui.annotate(
            {"type": "tool_start", "id": "u1", "name": "filter_library", "input": {"series": "X"}}
        )
    )
    assert all(f["ui_action"] is True for f in frames)
    assert frames[1]["input"] == {"series": "X"}


def test_tool_end_data_vs_ui() -> None:
    data = _one({"type": "tool_end", "id": "t1", "name": "search_library", "status": "success"})
    assert data["agui"] == agui.TOOL_CALL_END and data["ui_action"] is False

    ui = _one(
        {
            "type": "tool_end",
            "id": "u1",
            "name": "filter_library",
            "status": "success",
            "input": {"series": "Droga Szamana"},
        }
    )
    assert ui["agui"] == agui.TOOL_CALL_RESULT and ui["ui_action"] is True
    assert ui["input"] == {"series": "Droga Szamana"}


def test_session_finish_ok_vs_error() -> None:
    ok = _one({"type": "session_finish", "text": "done", "ok": True})
    assert ok["agui"] == agui.RUN_FINISHED
    bad = _one({"type": "session_finish", "text": "", "ok": False})
    assert bad["agui"] == agui.RUN_ERROR


def test_error_maps_to_run_error() -> None:
    assert _one({"type": "error", "message": "boom"})["agui"] == agui.RUN_ERROR


def test_is_ui_tool() -> None:
    assert agui.is_ui_tool("filter_library")
    assert agui.is_ui_tool("open_book")
    assert not agui.is_ui_tool("search_library")
