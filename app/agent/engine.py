"""Chat sessions for the library assistant and their event stream.

Each chat session gets its own ``ResolvedConfig`` (its own agent and conversation memory) and its
own event queue, wired once. A request flushes the queue, emits ``session_start``, invokes the
agent and turns the strands-compose events into the small wire protocol the frontend reads:

    session_start -> (reasoning | token | tool_start | tool_end)* -> session_finish | error
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"
SESSION_TTL_SECONDS = 1800


class _Queue(Protocol):
    def flush(self) -> None: ...
    def emit_session_start(self, manifest: Any) -> None: ...
    async def get(self) -> Any: ...
    async def close(self, data: dict[str, Any] | None = None) -> None: ...
    def put_event(self, event: Any) -> None: ...


@dataclass
class ChatSession:
    session_id: str
    entry: Any
    queue: _Queue
    manifest: Any
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used: float = field(default_factory=time.monotonic)


class SessionFactory(Protocol):
    def __call__(self, session_id: str) -> ChatSession: ...


def compose_session_factory(settings: Settings) -> SessionFactory:
    """Real factory: load the strands-compose config for a new chat session."""
    # The YAML reads the model and region from the environment; .env values only live in
    # Settings, so copy them over (an explicitly exported variable still wins).
    os.environ.setdefault("BEDROCK_MODEL_ID", settings.bedrock_model_id)
    os.environ.setdefault("AWS_REGION", settings.aws_region)

    def factory(session_id: str) -> ChatSession:
        from strands_compose import load
        from strands_compose.manifest import build_manifest

        resolved = load(CONFIG_PATH, session_id=session_id)
        queue = resolved.wire_event_queue(session_id=session_id)
        manifest = build_manifest(resolved.agents, resolved.orchestrators, resolved.entry)
        return ChatSession(
            session_id=session_id, entry=resolved.entry, queue=queue, manifest=manifest
        )

    return factory


class ChatEngine:
    def __init__(self, factory: SessionFactory, *, max_sessions: int = 50) -> None:
        self._factory = factory
        self._max_sessions = max_sessions
        self._sessions: dict[str, ChatSession] = {}

    def _evict(self) -> None:
        now = time.monotonic()
        for sid in [
            s for s, v in self._sessions.items() if now - v.last_used > SESSION_TTL_SECONDS
        ]:
            del self._sessions[sid]
        while len(self._sessions) >= self._max_sessions:
            oldest = min(self._sessions.values(), key=lambda s: s.last_used)
            del self._sessions[oldest.session_id]

    def session(self, session_id: str | None) -> ChatSession:
        if session_id and session_id in self._sessions:
            found = self._sessions[session_id]
            found.last_used = time.monotonic()
            return found
        self._evict()
        sid = session_id or uuid.uuid4().hex
        created = self._factory(sid)
        self._sessions[sid] = created
        return created

    def reset(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    async def stream(self, message: str, session_id: str | None) -> AsyncIterator[dict[str, Any]]:
        """Run one chat turn and yield wire events."""
        chat = self.session(session_id)
        async with chat.lock:
            chat.queue.flush()
            chat.queue.emit_session_start(chat.manifest)
            outcome: dict[str, Any] = {}

            async def run() -> None:
                try:
                    result = await chat.entry.invoke_async(message)
                    outcome["text"] = str(result)
                except Exception as exc:  # noqa: BLE001 - reported to the client as an error event
                    logger.exception("agent turn failed")
                    outcome["error"] = f"{type(exc).__name__}: {exc}"
                finally:
                    await chat.queue.close(outcome)

            task = asyncio.create_task(run())
            final_text = ""
            errored = False
            try:
                while (event := await chat.queue.get()) is not None:
                    kind = str(event.type)
                    data: dict[str, Any] = event.data or {}
                    if kind == "session_start":
                        yield {"type": "session_start", "session_id": chat.session_id}
                    elif kind == "token":
                        yield {"type": "token", "text": data.get("text", "")}
                    elif kind == "reasoning":
                        yield {"type": "reasoning", "text": data.get("text", "")}
                    elif kind == "tool_start":
                        yield {
                            "type": "tool_start",
                            "id": data.get("tool_use_id", ""),
                            "name": data.get("tool_name", ""),
                            "input": data.get("tool_input", {}),
                        }
                    elif kind == "tool_end":
                        yield {
                            "type": "tool_end",
                            "id": data.get("tool_use_id", ""),
                            "name": data.get("tool_name", ""),
                            "status": data.get("status", "success"),
                        }
                    elif kind == "agent_complete":
                        final_text = data.get("text", "") or final_text
                    elif kind == "error":
                        errored = True
                        yield {"type": "error", "message": data.get("text", "agent error")}
                    elif kind == "session_end":
                        if data.get("error") and not errored:
                            errored = True
                            yield {"type": "error", "message": data["error"]}
                        yield {
                            "type": "session_finish",
                            "session_id": chat.session_id,
                            "text": (data.get("text") or final_text).strip(),
                            "ok": not errored,
                        }
            finally:
                if not task.done():
                    task.cancel()
