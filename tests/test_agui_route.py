"""POST /api/agui/run — the browser-side AG-UI agent endpoint (route level)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agent import ui_agent


def _frames(raw: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in raw.split("\n\n"):
        line = block.strip()
        if line.startswith("data:"):
            out.append(json.loads(line[len("data:") :].strip()))
    return out


def test_run_streams_tool_call_sequence(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_streamer(region: str):
        def stream(*, model_id, system, messages, tool_config):
            def gen() -> Iterator[dict[str, Any]]:
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": "c1", "name": "filter_library"}}
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"series":"X"}'}}}}
                yield {"contentBlockStop": {}}

            return gen()

        return stream

    monkeypatch.setattr(ui_agent, "boto3_streamer", fake_streamer)

    body = {
        "threadId": "t1",
        "runId": "r1",
        "messages": [{"role": "user", "content": "pokaż serię X"}],
        "tools": [
            {
                "name": "filter_library",
                "description": "filter",
                "parameters": {"type": "object", "properties": {}},
            }
        ],
        "state": {"tab": "library"},
    }
    resp = client.post("/api/agui/run", json=body)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    frames = _frames(resp.text)
    types = [f["type"] for f in frames]
    assert types[0] == ui_agent.RUN_STARTED
    assert ui_agent.TOOL_CALL_START in types
    assert ui_agent.TOOL_CALL_END in types
    assert types[-1] == ui_agent.RUN_FINISHED
    end = next(f for f in frames if f["type"] == ui_agent.TOOL_CALL_END)
    assert end["toolCallName"] == "filter_library"
    assert json.loads(end["args"]) == {"series": "X"}


def test_run_reports_run_error_when_bedrock_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom_streamer(region: str):
        def stream(*, model_id, system, messages, tool_config):
            def gen() -> Iterator[dict[str, Any]]:
                raise RuntimeError("NoCredentialsError")
                yield  # pragma: no cover

            return gen()

        return stream

    monkeypatch.setattr(ui_agent, "boto3_streamer", boom_streamer)

    resp = client.post(
        "/api/agui/run",
        json={"threadId": "t", "runId": "r", "messages": [{"role": "user", "content": "x"}]},
    )
    assert resp.status_code == 200
    frames = _frames(resp.text)
    assert frames[-1]["type"] == ui_agent.RUN_ERROR
    assert "NoCredentialsError" in frames[-1]["message"]
