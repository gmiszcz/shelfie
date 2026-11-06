"""AG-UI event protocol mapping for the library assistant stream.

The backend already streams a small wire protocol over SSE (``session_start``,
``token``, ``reasoning``, ``tool_start``, ``tool_end``, ``error``,
``session_finish``). This module maps each of those wire events onto the
canonical `AG-UI <https://github.com/ag-ui-protocol>`_ event names and carries
that name in an extra ``agui`` field on every event.

Keeping the existing ``type`` values as the transport means the current
frontend SSE parser and reducer keep working unchanged (backward compatible),
while an AG-UI-aware client can switch on the ``agui`` field instead.

Mapping
-------

===================  ==========================================================
wire ``type``        ``agui`` event name(s)
===================  ==========================================================
``session_start``    ``RUN_STARTED``
``reasoning``        ``THINKING_TEXT_MESSAGE_CONTENT``
``token``            ``TEXT_MESSAGE_CONTENT``
``tool_start``       ``TOOL_CALL_START`` then ``TOOL_CALL_ARGS``
``tool_end``         ``TOOL_CALL_END`` (``TOOL_CALL_RESULT`` for data tools)
``error``            ``RUN_ERROR``
``session_finish``   ``RUN_FINISHED`` (``RUN_ERROR`` first when not ok)
===================  ==========================================================

A ``tool_start`` is expanded into two AG-UI frames so a consumer sees the call
name before its arguments, matching the AG-UI streaming contract. Frontend
("UI") tools additionally carry ``ui_action: True`` and echo their arguments on
``TOOL_CALL_END`` so the client can execute the action (dispatch the
``shelfie:ui`` CustomEvent) without re-reading ``tool_start``.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

# AG-UI canonical event names (the subset Shelfie emits).
RUN_STARTED = "RUN_STARTED"
RUN_FINISHED = "RUN_FINISHED"
RUN_ERROR = "RUN_ERROR"
TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
TOOL_CALL_START = "TOOL_CALL_START"
TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
TOOL_CALL_END = "TOOL_CALL_END"
TOOL_CALL_RESULT = "TOOL_CALL_RESULT"

# Frontend-executed tools: the agent's call is streamed to the browser, which
# runs it by dispatching the shelfie:ui CustomEvent (see docs/agent-ag-ui-bedrock.md).
UI_TOOL_NAMES: frozenset[str] = frozenset(
    {"filter_library", "clear_filter", "navigate", "open_book"}
)


def is_ui_tool(name: str) -> bool:
    """True when ``name`` is a frontend ("UI") tool executed in the browser."""
    return name in UI_TOOL_NAMES


def annotate(event: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield the AG-UI-annotated frame(s) for one wire event.

    Every yielded frame keeps its original ``type`` (transport stays backward
    compatible) and gains an ``agui`` field with the canonical AG-UI event name.
    A ``tool_start`` yields two frames (START then ARGS); every other wire event
    yields exactly one. Unknown event types pass through unchanged (no ``agui``).
    """
    kind = event.get("type")

    if kind == "session_start":
        yield {**event, "agui": RUN_STARTED}
    elif kind == "reasoning":
        yield {**event, "agui": THINKING_TEXT_MESSAGE_CONTENT}
    elif kind == "token":
        yield {**event, "agui": TEXT_MESSAGE_CONTENT}
    elif kind == "tool_start":
        name = str(event.get("name", ""))
        ui = is_ui_tool(name)
        yield {
            "type": "tool_start",
            "agui": TOOL_CALL_START,
            "id": event.get("id", ""),
            "name": name,
            "ui_action": ui,
        }
        yield {
            "type": "tool_args",
            "agui": TOOL_CALL_ARGS,
            "id": event.get("id", ""),
            "name": name,
            "input": event.get("input", {}),
            "ui_action": ui,
        }
    elif kind == "tool_end":
        name = str(event.get("name", ""))
        ui = is_ui_tool(name)
        yield {
            "type": "tool_end",
            "agui": TOOL_CALL_END if not ui else TOOL_CALL_RESULT,
            "id": event.get("id", ""),
            "name": name,
            "status": event.get("status", "success"),
            "input": event.get("input", {}),
            "ui_action": ui,
        }
    elif kind == "error":
        yield {**event, "agui": RUN_ERROR}
    elif kind == "session_finish":
        yield {**event, "agui": RUN_FINISHED if event.get("ok", True) else RUN_ERROR}
    else:
        yield dict(event)
