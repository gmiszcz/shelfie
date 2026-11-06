"""Thin Bedrock runner for the browser-side AG-UI agent (app.agent.ui_agent)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from app.agent import ui_agent


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


def test_state_snapshot_goes_into_system_prompt() -> None:
    _, captured = _split(_run(_fake_text_stream, state={"tab": "library", "starFilter": 5}))
    system_text = captured["system"][0]["text"]
    assert "Current UI state" in system_text
    assert '"tab":"library"' in system_text


def test_streamer_exception_becomes_run_error() -> None:
    def boom() -> Iterator[dict[str, Any]]:
        raise RuntimeError("NoCredentials")
        yield  # pragma: no cover

    events, _ = _split(_run(boom))
    assert events[0]["type"] == ui_agent.RUN_STARTED
    assert events[-1]["type"] == ui_agent.RUN_ERROR
    assert "NoCredentials" in events[-1]["message"]
