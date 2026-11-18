"""POST /api/agui - the assistant over AG-UI (route level, no Bedrock)."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from strands_compose import StreamEvent

from app.api.deps import agent_sessions
from app.main import app

THREAD = "6f1c2a8e-1d2b-4c3d-9e8f-0a1b2c3d4e5f"


class FakeSessions:
    """Records what the route passed in and streams a canned answer."""

    def __init__(self) -> None:
        self.calls: list[Any] = []
        self.resets: list[tuple[int, str]] = []

    async def stream(self, user_id: int, invocation: Any) -> AsyncGenerator[StreamEvent]:
        self.calls.append((user_id, invocation))
        yield StreamEvent(type="session_start", agent_name="librarian", data={})
        yield StreamEvent(type="token", agent_name="librarian", data={"text": "Cześć"})
        yield StreamEvent(type="session_end", agent_name="librarian", data={"text": "Cześć"})

    def reset(self, user_id: int, thread_id: str) -> bool:
        self.resets.append((user_id, thread_id))
        return True


@pytest.fixture
def fake(client: TestClient) -> Iterator[FakeSessions]:
    sessions = FakeSessions()
    app.dependency_overrides[agent_sessions] = lambda: sessions
    yield sessions
    app.dependency_overrides.pop(agent_sessions, None)


def _run_input(**extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "threadId": THREAD,
        "runId": "run-1",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "pokaż Diunę"}],
        "tools": [
            {
                "name": "navigate",
                "description": "Switch tab",
                "parameters": {"type": "object", "properties": {"tab": {"type": "string"}}},
            }
        ],
        "context": [{"description": "Visible tab", "value": "library"}],
        "forwardedProps": {},
    }
    body.update(extra)
    return body


def _frames(text: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


def test_run_streams_agui_events_and_passes_tools_and_context(
    client: TestClient, fake: FakeSessions
) -> None:
    resp = client.post("/api/agui", json=_run_input())
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    types = [f["type"] for f in _frames(resp.text)]
    assert types[0] == "RUN_STARTED"
    assert "TEXT_MESSAGE_CONTENT" in types
    assert types[-1] == "RUN_FINISHED"

    _user_id, invocation = fake.calls[0]
    assert invocation.agent_input == "pokaż Diunę"
    assert [t["name"] for t in invocation.client_tools] == ["navigate"]
    assert invocation.client_context == "- Visible tab: library"


def test_thread_id_must_be_uuid(client: TestClient, fake: FakeSessions) -> None:
    resp = client.post("/api/agui", json=_run_input(threadId="not-a-uuid"))
    assert resp.status_code == 422
    assert resp.json()["type"].endswith("invalid-thread-id")
    assert fake.calls == []


def test_invalid_body_is_422(client: TestClient, fake: FakeSessions) -> None:
    assert client.post("/api/agui", json={"hello": 1}).status_code == 422


def test_reset_thread(client: TestClient, fake: FakeSessions) -> None:
    assert client.delete(f"/api/agui/threads/{THREAD.upper()}").status_code == 204
    assert fake.resets[0][1] == THREAD
