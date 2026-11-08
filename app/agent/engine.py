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
from app.agent.dates import date_system_block
from app.config import Settings

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"
SESSION_TTL_SECONDS = 1800

#: The ONLY tools a read-only ("library_readonly") session may use. The librarian
#: config exposes read + write tools; for the read-only scope every tool NOT in this
#: set is pruned from the resolved agent's tool registry (see ``_apply_scope``), so a
#: read-only session physically cannot add / update / delete / change anything — the
#: guarantee is enforced server-side, not only by the prompt.
READONLY_TOOLS: frozenset[str] = frozenset(
    {
        "search_library",
        "get_book",
        "get_book_details",
        "list_books",
        "reading_stats",
        "library_overview",
        "list_series",
        "get_series",
        "list_favourites",
        "list_waiting_list",
        "series_alerts",
    }
)

#: The "library_add" scope (the UI agent's librarian_add tool): read + ADD only. It can
#: look things up, add a book (Google Books, title + author checked) and put a book in a
#: series. It cannot update, delete, merge, rename or change anything else.
ADD_TOOLS: frozenset[str] = READONLY_TOOLS | frozenset({"add_book", "add_book_to_series"})

#: Valid chat scopes. "library" is the full read+write assistant; "library_readonly"
#: is the answer-only scope the UI agent's ask_librarian tool uses; "library_add" is
#: read + add (the UI agent's librarian_add tool).
VALID_SCOPES: frozenset[str] = frozenset({"library", "library_readonly", "library_add"})

#: Tools each restricted scope keeps; every other tool is pruned. "library" keeps all.
SCOPE_TOOLS: dict[str, frozenset[str]] = {
    "library_readonly": READONLY_TOOLS,
    "library_add": ADD_TOOLS,
}


def _apply_scope(entry: Any, scope: str) -> None:
    """Prune write tools from ``entry`` when ``scope`` is read-only.

    Enforcement lives here, on the resolved agent, so a read-only librarian session
    has no write tool in its registry at all — the model cannot call what it does not
    have. A ``library`` (default) scope is left untouched.
    """
    allowed = SCOPE_TOOLS.get(scope)
    if allowed is None:
        return
    registry = getattr(entry, "tool_registry", None)
    if registry is None:  # pragma: no cover - entry is always a strands Agent here
        return
    for name in list(registry.registry):
        if name not in allowed:
            registry.remove(name)


def _readonly_prompt_note() -> str:
    """The extra system rule a read-only session gets: answer only, never change data."""
    return (
        "\n\nREAD-ONLY MODE: you can ONLY look things up and answer. You have NO tools "
        "to add, update, delete or otherwise change the library, any book, any series, "
        "the waiting list, favourites or alerts, and you must not claim to have changed "
        "anything. If the user asks you to add, remove, edit, rename, merge, mark or "
        "otherwise modify data, refuse briefly and explain they must do it themselves in "
        "the app."
    )


def _add_prompt_note() -> str:
    """The extra rule for the add-only scope (the UI agent's librarian_add tool)."""
    return (
        "\n\nADD MODE: the request comes from the in-app voice/UI assistant. You can look "
        "things up and ADD books (add_book, add_book_to_series) - nothing else: no update, "
        "delete, rename, merge or other change. To add a book, first find the exact title "
        "and author: for a series volume look the series up (get_series / search_library), "
        "e.g. 'Bezsilna tom 2' -> the series author and that volume's real title. Then call "
        "add_book with query AND title AND authors (plus series and volume). If no Google "
        "Books hit matches, nothing is added: name the candidates briefly and ask. Never add "
        "a book whose title or author does not match. Reply in one or two short sentences: "
        "what was added (title, author, series/volume) or why not."
    )


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
    #: The librarian's STATIC system prompt as resolved from the YAML. The per-reply
    #: date note is appended to this fresh each turn (see ``_apply_date_prompt``), so a
    #: long-lived session stays correct across midnight and never accumulates stale
    #: date notes.
    base_system_prompt: str | None = None
    #: Scope this session was created for ("library" = read+write, "library_readonly"
    #: = read-only, enforced server-side by pruning the write tools; see ``_factory``).
    scope: str = "library"
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used: float = field(default_factory=time.monotonic)


class SessionFactory(Protocol):
    def __call__(self, session_id: str, scope: str = "library") -> ChatSession: ...


def compose_session_factory(settings: Settings) -> SessionFactory:
    """Real factory: load the strands-compose config for a new chat session."""
    # The YAML reads the model and region from the environment; .env values only live in
    # Settings, so copy them over (an explicitly exported variable still wins).
    os.environ.setdefault("BEDROCK_MODEL_ID", settings.bedrock_model_id)
    os.environ.setdefault("AWS_REGION", settings.aws_region)

    def factory(session_id: str, scope: str = "library") -> ChatSession:
        from strands_compose import load
        from strands_compose.manifest import build_manifest

        resolved = load(CONFIG_PATH, session_id=session_id)
        _apply_scope(resolved.entry, scope)
        queue = resolved.wire_event_queue(session_id=session_id)
        manifest = build_manifest(resolved.agents, resolved.orchestrators, resolved.entry)
        base_prompt = getattr(resolved.entry, "system_prompt", None)
        if scope == "library_readonly" and isinstance(base_prompt, str):
            base_prompt = base_prompt + _readonly_prompt_note()
        elif scope == "library_add" and isinstance(base_prompt, str):
            base_prompt = base_prompt + _add_prompt_note()
        return ChatSession(
            session_id=session_id,
            entry=resolved.entry,
            queue=queue,
            manifest=manifest,
            base_system_prompt=base_prompt,
            scope=scope,
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

    def session(self, user_id: int, session_id: str | None, scope: str = "library") -> ChatSession:
        key = self._key(user_id, session_id, scope) if session_id else None
        if key and key in self._sessions:
            found = self._sessions[key]
            found.last_used = time.monotonic()
            return found
        self._evict()
        sid = session_id or uuid.uuid4().hex
        created = self._factory(sid, scope)
        self._sessions[self._key(user_id, sid, scope)] = created
        return created

    @staticmethod
    def _key(user_id: int, session_id: str, scope: str = "library") -> str:
        """Internal dict key: a chat session belongs to exactly one user AND scope.

        The client-facing id stays ``session_id`` (``ChatSession.session_id``); the user id
        is folded into the storage key so user A can never load user B's chat session. The
        scope is folded in too so a read+write session and a read-only session that happen
        to share an id (e.g. the UI thread's id) never alias each other's tool set.
        """
        return f"{user_id}:{scope}:{session_id}"

    def reset(self, user_id: int, session_id: str) -> bool:
        """Drop every scope of ``(user_id, session_id)``. Returns True if any existed."""
        removed = False
        for scope in VALID_SCOPES:
            if self._sessions.pop(self._key(user_id, session_id, scope), None) is not None:
                removed = True
        return removed

    @staticmethod
    def _apply_date_prompt(chat: ChatSession) -> None:
        """Set the librarian's system prompt to base + the CURRENT date note, this turn.

        Rebuilt every turn from the live clock, appended to the captured STATIC prompt
        (never to the previous turn's prompt), so a long-lived session cannot drift
        past midnight and the date note never piles up. A no-op when the base prompt or
        the entry's ``system_prompt`` setter is unavailable (e.g. a fake entry in tests).
        """
        base = chat.base_system_prompt
        if base is None or not hasattr(type(chat.entry), "system_prompt"):
            return
        try:
            chat.entry.system_prompt = base + "\n\n" + date_system_block()
        except (AttributeError, TypeError):  # pragma: no cover - non-Agent entry in tests
            pass

    async def stream(
        self, user_id: int, message: str, session_id: str | None, scope: str = "library"
    ) -> AsyncIterator[dict[str, Any]]:
        """Run one chat turn and yield AG-UI-annotated wire events.

        The entry agent is the single librarian assistant. ``scope`` selects its
        powers: "library" (default) can both read and change the library's data;
        "library_readonly" can ONLY answer — its write tools are pruned server-side
        (see :func:`_apply_scope`). It does NOT drive the UI; that is the separate UI
        agent's job. Every yielded event keeps its backward-compatible ``type`` and
        carries the canonical AG-UI name in ``agui`` (see :mod:`app.agent.agui`).

        The current-date note is injected into the system prompt here, in code, fresh
        every turn (so "this year" always means the real current year, even across
        midnight in a long session).

        Sessions are keyed by ``(user_id, scope, session_id)``: one user can never
        load another user's chat session, and a read-only session never aliases a
        read+write one.
        """
        if scope not in VALID_SCOPES:
            scope = "library"
        chat = self.session(user_id, session_id, scope)
        async with chat.lock:
            self._apply_date_prompt(chat)
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
