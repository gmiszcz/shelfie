"""Thin Bedrock runner for the browser-side AG-UI agent (app.agent.ui_agent)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from app.agent import ui_agent


@pytest.fixture(autouse=True)
def _reset_prompt_cache_flags() -> Iterator[None]:
    """Each test starts with prompt caching enabled and the 'warned once' flag clear."""
    ui_agent._prompt_cache_enabled = True
    ui_agent._prompt_cache_warned = False
    yield
    ui_agent._prompt_cache_enabled = True
    ui_agent._prompt_cache_warned = False


def _fake_text_stream() -> Iterator[dict[str, Any]]:
    """A converse_stream that answers with plain text, no tool call."""
    yield {"contentBlockDelta": {"delta": {"text": "Pokazuję "}}}
    yield {"contentBlockDelta": {"delta": {"text": "5 książek."}}}
    yield {"contentBlockStop": {}}
    yield {"messageStop": {"stopReason": "end_turn"}}


def _fake_tool_stream() -> Iterator[dict[str, Any]]:
    """A converse_stream that asks to call filter_library(series=...)."""
    yield {
        "contentBlockStart": {
            "start": {"toolUse": {"toolUseId": "tool-1", "name": "filter_library"}}
        }
    }
    yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"series":'}}}}
    yield {"contentBlockDelta": {"delta": {"toolUse": {"input": ' "Droga Szamana"}'}}}}
    yield {"contentBlockStop": {}}
    yield {"messageStop": {"stopReason": "tool_use"}}


def _run(stream_factory, messages=None, tools=None, state=None) -> list[dict[str, Any]]:
    captured: dict[str, Any] = {}

    def streamer(*, model_id, system, messages, tool_config):
        captured["model_id"] = model_id
        captured["system"] = system
        captured["messages"] = messages
        captured["tool_config"] = tool_config
        return stream_factory()

    events = list(
        ui_agent.run_stream(
            thread_id="t1",
            run_id="r1",
            messages=messages or [{"role": "user", "content": "pokaż serię"}],
            tools=tools or [],
            state=state,
            model_id="model-x",
            region="eu-central-1",
            streamer=streamer,
        )
    )
    events_captured = events
    events_captured.append({"__captured__": captured})  # tuck context for the caller
    return events_captured


def _split(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    captured = events[-1]["__captured__"]
    return events[:-1], captured


def test_text_turn_emits_run_text_run_finished() -> None:
    events, _ = _split(_run(_fake_text_stream))
    types = [e["type"] for e in events]
    assert types == [
        ui_agent.RUN_STARTED,
        ui_agent.TEXT_MESSAGE_START,
        ui_agent.TEXT_MESSAGE_CONTENT,
        ui_agent.TEXT_MESSAGE_CONTENT,
        ui_agent.TEXT_MESSAGE_END,
        ui_agent.RUN_FINISHED,
    ]
    text = "".join(e["delta"] for e in events if e["type"] == ui_agent.TEXT_MESSAGE_CONTENT)
    assert text == "Pokazuję 5 książek."


def test_tool_turn_ends_with_tool_call_then_run_finished() -> None:
    events, _ = _split(_run(_fake_tool_stream))
    types = [e["type"] for e in events]
    assert types == [
        ui_agent.RUN_STARTED,
        ui_agent.TOOL_CALL_START,
        ui_agent.TOOL_CALL_ARGS,
        ui_agent.TOOL_CALL_ARGS,
        ui_agent.TOOL_CALL_END,
        ui_agent.RUN_FINISHED,
    ]
    end = next(e for e in events if e["type"] == ui_agent.TOOL_CALL_END)
    assert end["toolCallName"] == "filter_library"
    assert json.loads(end["args"]) == {"series": "Droga Szamana"}


def test_tools_become_bedrock_tool_config() -> None:
    tools = [
        {
            "name": "navigate",
            "description": "switch tab",
            "parameters": {"type": "object", "properties": {"tab": {"type": "string"}}},
        }
    ]
    _, captured = _split(_run(_fake_text_stream, tools=tools))
    spec = captured["tool_config"]["tools"][0]["toolSpec"]
    assert spec["name"] == "navigate"
    assert spec["inputSchema"]["json"]["properties"]["tab"] == {"type": "string"}


def test_no_tools_means_no_tool_config() -> None:
    _, captured = _split(_run(_fake_text_stream, tools=[]))
    assert captured["tool_config"] is None


def test_messages_translate_user_assistant_toolresult() -> None:
    messages = [
        {"role": "user", "content": "pokaż serię"},
        {
            "role": "assistant",
            "content": "",
            "toolCalls": [{"id": "c1", "name": "find_books", "args": {"query": "Droga Szamana"}}],
        },
        {"role": "tool", "toolCallId": "c1", "content": json.dumps({"count": 2})},
    ]
    _, captured = _split(_run(_fake_text_stream, messages=messages))
    out = captured["messages"]
    assert out[0] == {"role": "user", "content": [{"text": "pokaż serię"}]}
    # Assistant tool call -> a toolUse block.
    assert out[1]["role"] == "assistant"
    tool_use = out[1]["content"][0]["toolUse"]
    assert tool_use["name"] == "find_books"
    assert tool_use["input"] == {"query": "Droga Szamana"}
    # Tool result -> a toolResult inside a user message.
    tool_result = out[2]["content"][0]["toolResult"]
    assert tool_result["toolUseId"] == "c1"


def _system_text(captured: dict[str, Any]) -> str:
    """The concatenated text of every system block (cachePoint blocks have no text)."""
    return "\n".join(b.get("text", "") for b in captured["system"] if "text" in b)


def test_multiple_tool_results_merge_into_one_user_message() -> None:
    # An assistant turn with TWO tool calls, then TWO tool-result messages. Bedrock
    # needs BOTH toolResults in the single user message after the assistant turn —
    # separate user messages fail with "Expected toolResult blocks …".
    messages = [
        {"role": "user", "content": "pokaż dune"},
        {
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {"id": "c1", "name": "navigate", "args": {"tab": "library"}},
                {"id": "c2", "name": "set", "args": {"id": "library.search", "value": "dune"}},
            ],
        },
        {"role": "tool", "toolCallId": "c1", "content": json.dumps({"ok": True})},
        {"role": "tool", "toolCallId": "c2", "content": json.dumps({"ok": True})},
    ]
    _, captured = _split(_run(_fake_text_stream, messages=messages))
    out = captured["messages"]
    # user, assistant(2 toolUse), user(2 toolResult).
    assert len(out) == 3
    assert out[1]["role"] == "assistant"
    assert [b["toolUse"]["toolUseId"] for b in out[1]["content"]] == ["c1", "c2"]
    assert out[2]["role"] == "user"
    result_ids = [b["toolResult"]["toolUseId"] for b in out[2]["content"]]
    assert result_ids == ["c1", "c2"]


def test_state_snapshot_goes_into_system_prompt() -> None:
    _, captured = _split(_run(_fake_text_stream, state={"tab": "library", "starFilter": 5}))
    system_text = _system_text(captured)
    assert "Current UI state" in system_text
    assert '"tab":"library"' in system_text


def test_static_prompt_and_dynamic_state_are_separate_blocks() -> None:
    # The static prompt must be its own block (cacheable); the date + UI state go in a
    # SEPARATE trailing block so changing state never invalidates the cached prefix.
    _, captured = _split(_run(_fake_text_stream, state={"tab": "library"}))
    blocks = captured["system"]
    assert "in-app assistant" in blocks[0]["text"]
    # The actual serialized state snapshot is only in the trailing dynamic block.
    assert '"tab":"library"' not in blocks[0]["text"]
    assert '"tab":"library"' in blocks[-1]["text"]
    assert "Today is" in blocks[-1]["text"]


def test_system_prompt_carries_the_current_date() -> None:
    import datetime as _dt

    _, captured = _split(_run(_fake_text_stream))
    system_text = _system_text(captured)
    year = _dt.datetime.now().astimezone().year
    assert "Today is" in system_text
    assert f"current year is {year}" in system_text
    # It must steer "this year" to finished_on, not a text search.
    assert "finished_on" in system_text
    assert "never" in system_text.lower()


def test_date_block_resolves_this_and_last_year() -> None:
    import datetime as _dt

    fixed = _dt.datetime(2026, 11, 7, 10, 0, tzinfo=_dt.timezone.utc)
    block = ui_agent._date_system_block(fixed)
    assert "2026-11-07" in block
    assert "current year is 2026" in block
    assert "last year" in block and "2025" in block


def test_prompt_cache_adds_cache_points_to_system_and_tools() -> None:
    ui_agent._prompt_cache_enabled = True
    tools = [{"name": "navigate", "description": "switch tab", "parameters": {"type": "object"}}]
    _, captured = _split(_run(_fake_text_stream, tools=tools))
    # A cachePoint sits between the static prompt block and the dynamic block.
    kinds = ["cachePoint" if "cachePoint" in b else "text" for b in captured["system"]]
    assert kinds == ["text", "cachePoint", "text"]
    # And a cachePoint trails the tool definitions.
    tool_entries = captured["tool_config"]["tools"]
    assert "cachePoint" in tool_entries[-1]


def test_prompt_cache_rejection_falls_back_and_disables() -> None:
    ui_agent._prompt_cache_enabled = True
    ui_agent._prompt_cache_warned = False
    calls: list[bool] = []

    def streamer(*, model_id, system, messages, tool_config):
        used_cache = any("cachePoint" in b for b in system)
        calls.append(used_cache)
        if used_cache:
            raise RuntimeError("This model does not support cachePoint blocks")
        yield from _fake_text_stream()

    events = list(
        ui_agent.run_stream(
            thread_id="t",
            run_id="r",
            messages=[{"role": "user", "content": "x"}],
            tools=[{"name": "navigate", "parameters": {"type": "object"}}],
            state=None,
            model_id="m",
            region="eu-central-1",
            streamer=streamer,
        )
    )
    # First attempt with cache rejected, retried without, then succeeded.
    assert calls == [True, False]
    assert ui_agent._prompt_cache_enabled is False
    assert events[-1]["type"] == ui_agent.RUN_FINISHED
    text = "".join(e.get("delta", "") for e in events if e["type"] == ui_agent.TEXT_MESSAGE_CONTENT)
    assert text == "Pokazuję 5 książek."


def test_turn_metrics_are_logged(caplog) -> None:
    import logging

    def streamer(*, model_id, system, messages, tool_config):
        yield {"contentBlockDelta": {"delta": {"text": "hi"}}}
        yield {"contentBlockStop": {}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1200, "outputTokens": 40},
                "metrics": {"latencyMs": 850},
            }
        }

    with caplog.at_level(logging.INFO, logger="app.agent.ui_agent"):
        list(
            ui_agent.run_stream(
                thread_id="t",
                run_id="run-xyz",
                messages=[{"role": "user", "content": "x"}],
                tools=[],
                state=None,
                model_id="m",
                region="eu-central-1",
                streamer=streamer,
            )
        )
    line = next(r.getMessage() for r in caplog.records if "ui_agent turn" in r.getMessage())
    assert "run=run-xyz" in line
    assert "in_tokens=1200" in line
    assert "out_tokens=40" in line
    assert "bedrock_latency_ms=850" in line


def test_streamer_exception_becomes_run_error() -> None:
    def boom() -> Iterator[dict[str, Any]]:
        raise RuntimeError("NoCredentials")
        yield  # pragma: no cover

    events, _ = _split(_run(boom))
    assert events[0]["type"] == ui_agent.RUN_STARTED
    assert events[-1]["type"] == ui_agent.RUN_ERROR
    assert "NoCredentials" in events[-1]["message"]
