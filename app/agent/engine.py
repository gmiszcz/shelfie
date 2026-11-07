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

from app.agent import agui
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
            oldest_key = min(self._sessions, key=lambda k: self._sessions[k].last_used)
            del self._sessions[oldest_key]

    def session(self, user_id: int, session_id: str | None) -> ChatSession:
        key = self._key(user_id, session_id) if session_id else None
        if key and key in self._sessions:
            found = self._sessions[key]
            found.last_used = time.monotonic()
            return found
        self._evict()
        sid = session_id or uuid.uuid4().hex
        created = self._factory(sid)
        self._sessions[self._key(user_id, sid)] = created
        return created

    @staticmethod
    def _key(user_id: int, session_id: str) -> str:
        """Internal dict key: a chat session belongs to exactly one user.

        The client-facing id stays ``session_id`` (``ChatSession.session_id``); the user id
        is folded into the storage key so user A can never load user B's chat session.
        """
        return f"{user_id}:{session_id}"

    def reset(self, user_id: int, session_id: str) -> bool:
        return self._sessions.pop(self._key(user_id, session_id), None) is not None

    async def stream(
        self, user_id: int, message: str, session_id: str | None, scope: str = "library"
    ) -> AsyncIterator[dict[str, Any]]:
        """Run one chat turn and yield AG-UI-annotated wire events.

        The entry agent is the single librarian assistant, which can both read and
        change the library's data (it does NOT drive the UI — that is the separate
        UI agent's job). ``scope`` is accepted for backward compatibility with the
        SSE route and is ignored: there is no longer a UI-control scope wired here.
        Every yielded event keeps its backward-compatible ``type`` and carries the
        canonical AG-UI name in ``agui`` (see :mod:`app.agent.agui`).

        Sessions are keyed by ``(user_id, session_id)``: one user can never load
        another user's chat session.
        """
        chat = self.session(user_id, session_id)
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
            # Remember each call's input from tool_start so tool_end can echo it
            # (the AG-UI annotation carries a tool's arguments through to the client).
            tool_inputs: dict[str, dict[str, Any]] = {}

            try:
                while (event := await chat.queue.get()) is not None:
                    kind = str(event.type)
                    data: dict[str, Any] = event.data or {}
                    raw: dict[str, Any] | None = None
                    if kind == "session_start":
                        raw = {"type": "session_start", "session_id": chat.session_id}
                    elif kind == "token":
                        raw = {"type": "token", "text": data.get("text", "")}
                    elif kind == "reasoning":
                        raw = {"type": "reasoning", "text": data.get("text", "")}
                    elif kind == "tool_start":
                        tool_id = data.get("tool_use_id", "")
                        tool_input = data.get("tool_input", {}) or {}
                        tool_inputs[tool_id] = tool_input
                        raw = {
                            "type": "tool_start",
                            "id": tool_id,
                            "name": data.get("tool_name", ""),
                            "input": tool_input,
                        }
                    elif kind == "tool_end":
                        tool_id = data.get("tool_use_id", "")
                        raw = {
                            "type": "tool_end",
                            "id": tool_id,
                            "name": data.get("tool_name", ""),
                            "status": data.get("status", "success"),
                            "input": tool_inputs.pop(tool_id, {}),
                        }
                    elif kind == "agent_complete":
                        final_text = data.get("text", "") or final_text
                    elif kind == "error":
                        errored = True
                        raw = {"type": "error", "message": data.get("text", "agent error")}
                    elif kind == "session_end":
                        if data.get("error") and not errored:
                            errored = True
                            for frame in agui.annotate({"type": "error", "message": data["error"]}):
                                yield frame
                        raw = {
                            "type": "session_finish",
                            "session_id": chat.session_id,
                            "text": (data.get("text") or final_text).strip(),
                            "ok": not errored,
                        }

                    if raw is not None:
                        for frame in agui.annotate(raw):
                            yield frame
            finally:
                if not task.done():
                    task.cancel()
