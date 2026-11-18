"""The Shelfie assistant's AG-UI sessions: one strands-compose agent per (user, thread).

``POST /api/agui`` (see ``app/api/routes/agui.py``) speaks the AG-UI protocol. The
pieces that turn an AG-UI run into an agent invocation and back come from
``strands-compose-agentcore``; this module only owns the sessions.

Why not ``strands_compose_agentcore.create_app``: that app keeps ONE session per
process (AgentCore Runtime gives every session its own micro-VM). Shelfie is one
process for every user, so a new thread would evict another user's chat and two
people asking at once would get ``AgentBusy``. Here every (user, threadId) pair has
its own session, guarded by its own lock, evicted after 30 idle minutes.

One AG-UI run:

1. ``RunAgentInput`` -> ``run_input_to_invocation``: the new user text or the
   browser's tool results, the browser's tool definitions and its screen context.
2. ``run_entry_agent``: the librarian runs with its own DB tools (``tools.py``) PLUS
   the browser tools (``allow_client_tools: true`` in ``config.yaml``). When it calls
   a browser tool the run ends and the call is pending; the browser runs it and sends
   the result in the next run of the same thread.
3. ``AguiSseStream``: the strands-compose events become AG-UI SSE frames.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from pathlib import Path

from strands_compose import AppConfig, StreamEvent, load_config
from strands_compose_agentcore._utils import error_event
from strands_compose_agentcore.agui.inbound import AguiInvocation
from strands_compose_agentcore.client.utils import build_invocation_body
from strands_compose_agentcore.payload import (
    parse_client_context,
    parse_client_tools,
    parse_payload,
)
from strands_compose_agentcore.session import (
    SessionState,
    close_session,
    resolve_session,
    run_entry_agent,
)

from app.agent.dates import date_system_block
from app.config import Settings

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"
SESSION_TTL_SECONDS = 1800
MAX_SESSIONS = 50
#: A run carries text and tool results only (no images), so 1 MiB is plenty.
MAX_PAYLOAD_BYTES = 1024 * 1024


@dataclass
class _Entry:
    state: SessionState
    last_used: float = field(default_factory=time.monotonic)


class AgentSessions:
    """Live agent sessions keyed by ``user_id:thread_id``."""

    def __init__(self, app_config: AppConfig) -> None:
        self._config = app_config
        self._sessions: dict[str, _Entry] = {}

    @classmethod
    def from_settings(cls, settings: Settings) -> AgentSessions:
        """Parse ``config.yaml`` once. The YAML reads the model and region from the env."""
        os.environ.setdefault("BEDROCK_MODEL_ID", settings.bedrock_model_id)
        os.environ.setdefault("AWS_REGION", settings.aws_region)
        return cls(load_config(CONFIG_PATH))

    def _evict(self) -> None:
        now = time.monotonic()
        stale = [k for k, e in self._sessions.items() if now - e.last_used > SESSION_TTL_SECONDS]
        while len(self._sessions) - len(stale) >= MAX_SESSIONS:
            rest = [k for k in self._sessions if k not in stale]
            stale.append(min(rest, key=lambda k: self._sessions[k].last_used))
        for key in stale:
            entry = self._sessions.pop(key)
            if not entry.state.invocation_lock.locked():
                close_session(entry.state)

    def _get(self, user_id: int, thread_id: str) -> SessionState:
        key = f"{user_id}:{thread_id}"
        entry = self._sessions.get(key)
        if entry is None:
            self._evict()
            # The AgentCore session id must be 33-256 chars; a UUID thread id is 36.
            entry = _Entry(resolve_session(self._config, thread_id))
            self._sessions[key] = entry
        entry.last_used = time.monotonic()
        return entry.state

    def reset(self, user_id: int, thread_id: str) -> bool:
        """Forget one thread ("new chat"). Returns True if it existed."""
        entry = self._sessions.pop(f"{user_id}:{thread_id}", None)
        if entry is None:
            return False
        if not entry.state.invocation_lock.locked():
            close_session(entry.state)
        return True

    async def stream(self, user_id: int, invocation: AguiInvocation) -> AsyncGenerator[StreamEvent]:
        """Run one AG-UI run of ``user_id`` and yield its strands-compose events."""
        payload = build_invocation_body(
            invocation.agent_input,
            client_tools=invocation.client_tools,
            client_context=_with_date(invocation.client_context),
        )
        try:
            agent_input = parse_payload(
                payload, max_payload_bytes=MAX_PAYLOAD_BYTES, max_media_bytes=0, max_media_blocks=0
            )
            client_tools = parse_client_tools(payload)
            client_context = parse_client_context(payload)
            session = self._get(user_id, invocation.thread_id.lower())
        except Exception as exc:  # noqa: BLE001 - reported to the browser as RUN_ERROR
            logger.exception("agui run rejected")
            yield error_event(str(exc), exception_type=type(exc).__name__)
            return

        if session.invocation_lock.locked():
            yield error_event("The assistant is still answering.", exception_type="AgentBusy")
            return

        async with session.invocation_lock:
            session.events.flush()
            session.events.emit_session_start(session.manifest)
            task = asyncio.create_task(
                run_entry_agent(
                    session.resolved,
                    session.events,
                    agent_input,
                    client_tools=client_tools,
                    client_context=client_context,
                )
            )
            completed = False
            try:
                while (event := await session.events.get()) is not None:
                    yield event
                completed = True
            finally:
                if completed:
                    await task
                else:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass


def _with_date(client_context: str | None) -> str:
    """Prepend today's date, rebuilt every run, so "this year" is always right."""
    line = f"- Current date: {date_system_block()}"
    return f"{line}\n{client_context}" if client_context else line
