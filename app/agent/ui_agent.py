"""Thin LLM runner for the browser-side (frontend-tools) AG-UI agent.

This is the *only* backend part of the UI agent. Every tool of the UI agent is
**defined and executed in the browser** (see ``frontend/src/agui/``); the server
exists only because Bedrock credentials cannot live in the browser.

One ``POST /api/agui/run`` request = one model turn:

- Input: ``{threadId, runId, messages, tools, state}`` where ``messages`` is the
  running AG-UI conversation (user / assistant / tool-result turns), ``tools`` is
  the list of JSON-Schema tool definitions the browser owns, and ``state`` is a
  read-only snapshot of ``window.__shelfieUiState``.
- The runner calls Bedrock (Claude Haiku 5.5) with ``converse_stream`` and
  translates the model's streamed output into **AG-UI events**:
  ``RUN_STARTED`` → (``TEXT_MESSAGE_START`` / ``TEXT_MESSAGE_CONTENT`` /
  ``TEXT_MESSAGE_END``) and/or (``TOOL_CALL_START`` / ``TOOL_CALL_ARGS`` /
  ``TOOL_CALL_END``) → ``RUN_FINISHED`` (or ``RUN_ERROR``).

When the model asks to call a tool, the turn **ends with that tool call**
(``TOOL_CALL_END`` then ``RUN_FINISHED``). The browser runs the tool, appends a
tool-result message and calls ``/api/agui/run`` again. The loop repeats until the
model answers with text and no tool call — exactly the CopilotKit / AG-UI
frontend-tools protocol.

This module has **no database access and no server-side tools**: it never looks a
book up, never touches SQLite. It only relays the browser's tool schemas to the
model and streams events back.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import datetime
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# --- AG-UI event names (the subset the UI agent emits) -----------------------------------

RUN_STARTED = "RUN_STARTED"
RUN_FINISHED = "RUN_FINISHED"
RUN_ERROR = "RUN_ERROR"
TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
TOOL_CALL_START = "TOOL_CALL_START"
TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
TOOL_CALL_END = "TOOL_CALL_END"

SYSTEM_PROMPT = """You are Shelfie's in-app assistant. You DRIVE THE USER INTERFACE of a
personal book-library web app by calling the tools you are given. Every tool runs in the
user's own browser, and the interface describes itself to you at runtime — there is no fixed
list of screens or controls baked into you.

Your tools are generic and work for ANY current or future tab and control:
- describe_ui: returns the whole UI as a schema — every tab (active or not) and the controls
  (anchors) it owns, each with an id, kind, label, current value, allowed options and actions;
  lists expose their items (e.g. the visible books) with ids and titles.
- get_state(id): read one control's current value.
- set(id, value): set a value control (text-input, search, select, toggle, multi-select).
- invoke(id, action?, args?): act on a button, dialog or list item (e.g. open a book, open a dialog).
- navigate(tab): switch the active tab.
- find_books(query): search the loaded books to resolve a name into exact ids/titles.
- series_releases(name, refresh?): a series' owned/missing volumes and its next volume per
  edition (Polish and original/English) with date, status and source. refresh=true runs a live
  web search for release news (up to ~60 s).

Rules:
- Answer in the SAME LANGUAGE the user writes in (Polish stays Polish).
- ALWAYS call describe_ui FIRST (unless you already hold a fresh schema this turn). Choose the
  control by its kind, label and description, and use the EXACT id from the schema. NEVER invent
  an id, an option value, a tab name or an action — they are only valid if they appear in the schema.
- ACT, do not merely describe. When the user asks to show, filter, open, add, switch or change
  anything on screen, call the matching tool instead of explaining how to do it by hand.
- Resolve real data first. When the user names a book, author or series, call find_books to get
  the exact stored title / series / ids, THEN set the relevant control or invoke open on the book.
- To change a tab's control, navigate to that tab first when it is not active (the schema marks the
  active tab and whether each tab is mounted); its anchors are listed even when it is not mounted.
- A set / invoke result reports ok, and on error lists the valid ids or option values — read it and
  correct your call rather than repeating it.
- After the UI changed, reply with ONE short sentence confirming what you did, in the user's
  language. Keep it concrete ("Pokazuję książki z serii Droga Szamana.").
- Never invent books, ids, ratings or counts. If find_books returns nothing, say so briefly.
- Release questions ("kiedy wyjdzie tom 7 Kronik Mroku", "czy wyszła ostatnia część", Polish
  premiere dates): call series_releases. If the asked edition has no date, or the user asks to
  check, call it again with refresh=true. Answer with the date and source for EACH edition
  (polskie / oryginalne) in a short reply. With no date say it is not announced ("nie
  ogłoszono"). Never guess a date and never tell the user to check it themselves.
"""


class ChatBedrockStreamer(Protocol):
    """Seam over Bedrock's ``converse_stream`` so the runner is unit-testable.

    An implementation yields raw ``converse_stream`` event dicts (the ``stream``
    part of the boto3 response), in order.
    """

    def __call__(
        self,
        *,
        model_id: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tool_config: dict[str, Any] | None,
    ) -> Iterator[dict[str, Any]]: ...


def boto3_streamer(region: str) -> ChatBedrockStreamer:
    """Real streamer: a boto3 ``bedrock-runtime`` client driving ``converse_stream``.

    Credentials come from the standard AWS chain (SSO / env / role), never from
    ``.env``. The client is created lazily on first use so importing this module
    never requires AWS to be configured (tests inject a fake streamer).
    """
    import boto3  # type: ignore[import-untyped]

    client = boto3.client("bedrock-runtime", region_name=region)

    def stream(
        *,
        model_id: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tool_config: dict[str, Any] | None,
    ) -> Iterator[dict[str, Any]]:
        kwargs: dict[str, Any] = {
            "modelId": model_id,
            "system": system,
            "messages": messages,
            "inferenceConfig": {"maxTokens": 2048},
        }
        if tool_config and tool_config.get("tools"):
            kwargs["toolConfig"] = tool_config
        response = client.converse_stream(**kwargs)
        yield from response["stream"]

    return stream


# --- request -> Bedrock translation ------------------------------------------------------


def _tool_config(tools: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Translate the browser's JSON-Schema tool list into a Bedrock ``toolConfig``.

    Each browser tool is ``{name, description, parameters}`` where ``parameters``
    is a JSON Schema object. Bedrock wants ``toolSpec.inputSchema.json``.
    """
    specs: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name", "")).strip()
        if not name:
            continue
        schema = tool.get("parameters") or {"type": "object", "properties": {}}
        specs.append(
            {
                "toolSpec": {
                    "name": name,
                    "description": str(tool.get("description", "") or name),
                    "inputSchema": {"json": schema},
                }
            }
        )
    return {"tools": specs} if specs else None


def _to_bedrock_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate the browser's AG-UI message list into Bedrock ``converse`` messages.

    Supported roles:
      - ``user`` / ``assistant`` with ``content`` (string) -> a text block.
      - ``assistant`` with ``toolCalls: [{id, name, args}]`` -> ``toolUse`` blocks.
      - ``tool`` with ``toolCallId`` + ``content`` -> a ``toolResult`` block
        (Bedrock requires it inside a ``user`` message).
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            tool_call_id = str(msg.get("toolCallId", "") or msg.get("tool_call_id", ""))
            content = msg.get("content", "")
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "toolResult": {
                                "toolUseId": tool_call_id,
                                "content": [{"text": text or "ok"}],
                            }
                        }
                    ],
                }
            )
            continue

        if role not in ("user", "assistant"):
            continue

        blocks: list[dict[str, Any]] = []
        content_text = msg.get("content")
        if isinstance(content_text, str) and content_text.strip():
            blocks.append({"text": content_text})
        for call in msg.get("toolCalls", []) or []:
            args = call.get("args", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except json.JSONDecodeError:
                    args = {}
            blocks.append(
                {
                    "toolUse": {
                        "toolUseId": str(call.get("id", "")),
                        "name": str(call.get("name", "")),
                        "input": args or {},
                    }
                }
            )
        if blocks:
            out.append({"role": role, "content": blocks})
    return out


def _now() -> datetime:
    """The current local date/time. A seam so the date block is testable."""
    return datetime.now().astimezone()


def _date_system_block(now: datetime | None = None) -> str:
    """A system note giving the model the current date, so "this year" etc. resolve.

    The UI agent has no clock of its own; without this it guesses the year (and in
    practice asks the user). We state today's date, the current year, and that a
    bare "this year" means books FINISHED in the current calendar year by default.
    """
    stamp = now or _now()
    tz = stamp.tzname() or "local"
    return (
        f"\n\nToday is {stamp.strftime('%Y-%m-%d')} ({stamp.strftime('%A')}), "
        f"timezone {tz}. The current year is {stamp.year}. "
        f'When the user says "this year" / "w tym roku" it means books FINISHED in '
        f"{stamp.year} (finished_on in {stamp.year}) unless they say otherwise; "
        f'"last year" means {stamp.year - 1}. Resolve any relative period (this/last '
        f"year, recent months) against this date and NEVER ask the user what year it is. "
        f"Use the structured library filters (finished year, date range, status, shelf, "
        f"tag, series, author, stars) for a year or period — never type a year into a "
        f"free-text search box. Say in one short line which interpretation you used "
        f'(e.g. "przeczytane w {stamp.year}").'
    )


def _state_system_block(state: Any) -> str:
    """A compact system note describing the current UI state, if provided."""
    if not isinstance(state, dict) or not state:
        return ""
    try:
        compact = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""
    return f"\n\nCurrent UI state (read-only snapshot): {compact}"


# --- the run: stream AG-UI events ---------------------------------------------------------


def run_stream(
    *,
    thread_id: str,
    run_id: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    state: Any,
    model_id: str,
    region: str,
    streamer: ChatBedrockStreamer | None = None,
) -> Iterator[dict[str, Any]]:
    """Run ONE model turn and yield AG-UI event dicts.

    Yields ``RUN_STARTED`` first and ``RUN_FINISHED`` (or ``RUN_ERROR``) last. In
    between it yields a text message (START / CONTENT* / END) when the model
    writes prose, and a tool call (TOOL_CALL_START / ARGS* / END) when the model
    decides to call a browser tool. A turn that emits a tool call does not also
    continue past it: the browser executes the tool and starts the next turn.
    """
    stream = streamer or boto3_streamer(region)

    yield {"type": RUN_STARTED, "threadId": thread_id, "runId": run_id}

    system = [{"text": SYSTEM_PROMPT + _date_system_block() + _state_system_block(state)}]
    bedrock_messages = _to_bedrock_messages(messages)
    tool_config = _tool_config(tools)

    # Per-content-block assembly state.
    text_message_id: str | None = None
    tool_use_id: str | None = None
    tool_name: str | None = None
    tool_args_buf = ""

    try:
        for event in stream(
            model_id=model_id,
            system=system,
            messages=bedrock_messages,
            tool_config=tool_config,
        ):
            if "contentBlockStart" in event:
                start = event["contentBlockStart"].get("start", {})
                tool_use = start.get("toolUse")
                if tool_use:
                    tool_use_id = str(tool_use.get("toolUseId", ""))
                    tool_name = str(tool_use.get("name", ""))
                    tool_args_buf = ""
                    yield {
                        "type": TOOL_CALL_START,
                        "toolCallId": tool_use_id,
                        "toolCallName": tool_name,
                    }
            elif "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    if text_message_id is None:
                        text_message_id = f"{run_id}-msg"
                        yield {"type": TEXT_MESSAGE_START, "messageId": text_message_id}
                    yield {
                        "type": TEXT_MESSAGE_CONTENT,
                        "messageId": text_message_id,
                        "delta": delta["text"],
                    }
                elif "toolUse" in delta:
                    chunk = delta["toolUse"].get("input", "")
                    tool_args_buf += chunk
                    yield {
                        "type": TOOL_CALL_ARGS,
                        "toolCallId": tool_use_id or "",
                        "delta": chunk,
                    }
            elif "contentBlockStop" in event:
                if tool_use_id is not None:
                    yield {
                        "type": TOOL_CALL_END,
                        "toolCallId": tool_use_id,
                        "toolCallName": tool_name or "",
                        "args": tool_args_buf,
                    }
                    tool_use_id = None
                    tool_name = None
                    tool_args_buf = ""
                elif text_message_id is not None:
                    yield {"type": TEXT_MESSAGE_END, "messageId": text_message_id}
                    text_message_id = None
            # messageStart / messageStop / metadata carry no AG-UI payload we surface.
    except Exception as exc:  # noqa: BLE001 - reported to the browser as RUN_ERROR
        logger.exception("UI agent run failed")
        # Close any half-open text block so the client is not left waiting.
        if text_message_id is not None:
            yield {"type": TEXT_MESSAGE_END, "messageId": text_message_id}
        yield {
            "type": RUN_ERROR,
            "threadId": thread_id,
            "runId": run_id,
            "message": f"{type(exc).__name__}: {exc}",
        }
        return

    yield {"type": RUN_FINISHED, "threadId": thread_id, "runId": run_id}
