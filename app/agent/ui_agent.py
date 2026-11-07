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
user's own browser.

Rules:
- Answer in the SAME LANGUAGE the user writes in (Polish stays Polish).
- ACT, do not merely describe. When the user asks to show, filter, open, add, switch or change
  anything on screen, call the matching tool instead of explaining how to do it by hand.
- Resolve real data first. When the user names a book, author or series, call find_books to get
  the exact stored title / series / ids, THEN call the tool that changes the UI
  (filter_library, open_book, ...).
- To learn the current screen state (active tab, search text, star filter, visible books), call
  get_ui_state.
- After the UI changed, reply with ONE short sentence confirming what you did, in the user's
  language. Keep it concrete ("Pokazuję 5 książek z serii Droga Szamana.").
- Never invent books, ids, ratings or counts. If find_books returns nothing, say so briefly.
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

    system = [{"text": SYSTEM_PROMPT + _state_system_block(state)}]
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
