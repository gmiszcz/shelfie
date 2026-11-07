"""Library assistant tests: event mapping, SSE endpoint and DB tools (no Bedrock calls)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from strands_compose.types import StreamEvent

from app.agent import tools
from app.agent.engine import ChatEngine, ChatSession
from app.api.deps import chat_engine
from app.main import app


class FakeQueue:
    def __init__(self) -> None:
        self._q: asyncio.Queue[Any] = asyncio.Queue()

    def flush(self) -> None:
        while not self._q.empty():
            self._q.get_nowait()

    def emit_session_start(self, manifest: Any) -> None:
        self._q.put_nowait(StreamEvent(type="session_start", agent_name="librarian"))

    def put_event(self, event: Any) -> None:
        self._q.put_nowait(event)

    async def get(self) -> Any:
        return await self._q.get()

    async def close(self, data: dict[str, Any] | None = None) -> None:
        self._q.put_nowait(StreamEvent(type="session_end", agent_name="librarian", data=data or {}))
        self._q.put_nowait(None)


class FakeEntry:
    def __init__(self, queue: FakeQueue, *, fail: bool = False) -> None:
        self.queue = queue
        self.fail = fail
        self.prompts: list[str] = []

    async def invoke_async(self, message: str) -> str:
        self.prompts.append(message)
        q = self.queue
        q.put_event(
            StreamEvent(type="reasoning", agent_name="librarian", data={"text": "Look it up."})
        )
        q.put_event(
            StreamEvent(
                type="tool_start",
                agent_name="librarian",
                data={
                    "tool_name": "search_library",
                    "tool_use_id": "t1",
                    "tool_input": {"query": "Dune"},
                },
            )
        )
        q.put_event(
            StreamEvent(
                type="tool_end",
                agent_name="librarian",
                data={"tool_name": "search_library", "tool_use_id": "t1", "status": "success"},
            )
        )
        if self.fail:
            raise RuntimeError("bedrock down")
        for part in ("You read ", "Dune."):
            q.put_event(StreamEvent(type="token", agent_name="librarian", data={"text": part}))
        return "You read Dune."


def _engine(fail: bool = False) -> tuple[ChatEngine, list[FakeEntry]]:
    created: list[FakeEntry] = []

    def factory(session_id: str) -> ChatSession:
        queue = FakeQueue()
        entry = FakeEntry(queue, fail=fail)
        created.append(entry)
        return ChatSession(session_id=session_id, entry=entry, queue=queue, manifest=None)

    return ChatEngine(factory), created


async def test_stream_maps_events_in_order() -> None:
    engine, _ = _engine()
    events = [e async for e in engine.stream(1, "What did I read?", "abc")]
    # tool_start now expands to a TOOL_CALL_START + TOOL_CALL_ARGS pair (AG-UI).
    assert [e["type"] for e in events] == [
        "session_start",
        "reasoning",
        "tool_start",
        "tool_args",
        "tool_end",
        "token",
        "token",
        "session_finish",
    ]
    # Every event carries its canonical AG-UI name.
    assert [e["agui"] for e in events] == [
        "RUN_STARTED",
        "THINKING_TEXT_MESSAGE_CONTENT",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "RUN_FINISHED",
    ]
    assert events[0]["session_id"] == "abc"
    assert events[2]["name"] == "search_library"
    assert events[3]["input"] == {"query": "Dune"}
    assert events[-1] == {
        "type": "session_finish",
        "session_id": "abc",
        "text": "You read Dune.",
        "ok": True,
        "agui": "RUN_FINISHED",
    }


async def test_session_is_reused_and_reset() -> None:
    engine, created = _engine()
    [e async for e in engine.stream(1, "one", "s1")]
    [e async for e in engine.stream(1, "two", "s1")]
    assert len(created) == 1 and created[0].prompts == ["one", "two"]
    assert engine.reset(1, "s1") is True
    [e async for e in engine.stream(1, "three", "s1")]
    assert len(created) == 2


async def test_agent_failure_becomes_error_then_finish() -> None:
    engine, _ = _engine(fail=True)
    events = [e async for e in engine.stream(1, "hi", "s")]
    assert events[-2]["type"] == "error" and "bedrock down" in events[-2]["message"]
    assert events[-1]["type"] == "session_finish" and events[-1]["ok"] is False


def test_chat_endpoint_streams_sse(client: TestClient) -> None:
    engine, _ = _engine()
    app.dependency_overrides[chat_engine] = lambda: engine
    try:
        resp = client.post("/api/agent/chat", json={"message": "hi", "session_id": "web1"})
    finally:
        app.dependency_overrides.pop(chat_engine, None)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]
    assert events[0]["type"] == "session_start"
    assert events[-1]["type"] == "session_finish" and events[-1]["text"] == "You read Dune."


def test_chat_rejects_bad_session_id(client: TestClient) -> None:
    resp = client.post("/api/agent/chat", json={"message": "hi", "session_id": "../etc"})
    assert resp.status_code == 422


@pytest.fixture
def library_db(client: TestClient, test_user_data: Any, db_file: Path) -> Path:
    for i, (title, author, finished) in enumerate(
        [
            ("Droga Szamana", "Wasilij Machanienko", "2020-09-25"),
            ("Dune", "Frank Herbert", "2024-05-01"),
        ]
    ):
        body = {
            "title": title,
            "authors": [author],
            "status": "finished",
            "finished_on": finished,
            "stars": 5,
            "shelves": ["Fantasy"],
            "google_volume_id": f"v{i}",
        }
        assert client.post("/api/books", json=body).status_code == 201
    from app.userdata import set_current_user_data

    set_current_user_data(test_user_data)
    return db_file


def test_tools_query_the_library(library_db: Path) -> None:
    found = tools.search_library(query="droga szamana")
    assert found["count"] == 1 and found["books"][0]["authors"] == ["Wasilij Machanienko"]

    listed = tools.list_books(year=2024)
    assert [b["title"] for b in listed["books"]] == ["Dune"]

    details = tools.get_book_details(book_id=found["books"][0]["id"])
    assert details["title"] == "Droga Szamana"
    assert tools.get_book_details(book_id=999)["error"]

    stats = tools.reading_stats(group_by="year")
    assert stats["summary"]["books"] == 2

    overview = tools.library_overview()
    assert overview["total"] == 2 and overview["by_shelf"] == {"Fantasy": 2}


def test_star_band_filter_in_search_and_list(library_db: Path) -> None:
    # Both seeded books are 5 stars (display_score None -> falls back to stars).
    assert tools.list_books(stars=5)["count"] == 2
    # A 4-star band (3.6..4.5) excludes both 5.0 books.
    assert tools.list_books(stars=4)["count"] == 0
    # search_library honours the band too (combined with the text query, AND).
    hit = tools.search_library(query="dune", stars=5)
    assert hit["count"] == 1 and hit["books"][0]["title"] == "Dune"
    assert tools.search_library(query="dune", stars=4)["count"] == 0
