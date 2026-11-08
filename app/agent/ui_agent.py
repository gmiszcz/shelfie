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
import time
from collections.abc import Iterator
from datetime import datetime
from typing import Any, Protocol

from app.agent.dates import date_system_block, now

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
- describe_ui: returns the whole UI schema — every tab and its controls (anchors) with id, kind,
  label, options and actions; lists expose their items (e.g. visible books) with ids and titles.
- get_state(id): read one control's current value.
- set(id, value): set a value control (text-input, search, select, toggle, multi-select).
- invoke(id, action?, args?): act on a button, dialog or list item (e.g. open a book, a dialog).
- navigate(tab): switch the active tab.
- find_books(query): search the loaded books to resolve a name into exact ids/titles.
- series_releases(name, refresh?): a series' owned/missing volumes and its next volume per
  edition (Polish and original/English) with date, status and source. refresh=true runs a live
  web search for release news (up to ~60 s).
- ask_librarian(question): ask the backend librarian a question about the library DATA and
  return its answer. The librarian reads the database (counts, dates, statistics, ratings,
  series progress, a book's details). It is READ-ONLY through this tool — it can only answer.
- librarian_add(request): ADD a book to the library. Hands the user's request (their words, with
  every detail: title, author, series, volume, status) to the backend librarian, which finds the
  right book in Google Books (title AND author must match), adds it with metadata and cover and
  puts it in its series. Its answer is shown verbatim — call it and stop.

How to work:
- You are ALREADY GIVEN the current UI schema in the "Current UI state" system block below, so
  you do NOT need to call describe_ui before acting — read it and act straight away. Call
  describe_ui ONLY after you navigate to a tab and need that tab's freshly mounted controls (its
  anchors are not in the snapshot until it is the active/mounted tab).
- Use the EXACT id, option value, tab name and action from the schema. NEVER invent one.
- You MAY call SEVERAL tools in one turn when they do not depend on each other (e.g. navigate to a
  tab and set one of its controls, or apply two filter facets at once) — issue them together
  instead of one per turn.
- Write your short confirmation sentence IN THE SAME TURN as your last action, so a simple request
  finishes without an extra turn. The loop ends when every tool in a turn succeeded and you also
  wrote text. On a tool error, the error lists the valid ids/values — correct your call and continue.

Choosing a tool — DATA questions vs SCREEN actions:
- Any question about the library's DATA — numbers, counts, dates, how many books, "what did I
  read", "ile przeczytałem w tym roku", statistics, ratings, which series am I missing, a book's
  details — you answer by calling ask_librarian(question) and NOTHING ELSE. The librarian reads
  the database; its answer is shown to the user as your reply verbatim, so do NOT paraphrase,
  summarise or add to it, and do NOT make another turn after it — call ask_librarian and stop.
  Never try to compute a count yourself from the UI schema or find_books.
- ADDING a book ("dodaj książkę X", "dodaj Bezsilna tom 2", "add Dune") — call
  librarian_add(request) and NOTHING ELSE; do not open the search window and do not type the
  title anywhere. Use library.addBook (the add/search window) ONLY when the user explicitly asks
  to OPEN that window ("otwórz dodawanie książki").
- SCREEN actions — show, filter, open, switch tab, add/change a control, apply a facet — use the
  UI tools (navigate / set / invoke / describe_ui / get_state), as before.
- Release questions ("kiedy wyjdzie tom…") use series_releases.

Rules:
- Answer in the SAME LANGUAGE the user writes in (Polish stays Polish).
- ACT, do not merely describe. When the user asks to show, filter, open, add, switch or change
  anything, call the matching tool instead of explaining how to do it by hand.
- Prefer the structured library filter. library.filter (action "apply") accepts human names for
  series / author / shelf / tag directly — it matches them itself (case, diacritics and simple
  inflection tolerant), so you usually do NOT need find_books for a plain filter. Use find_books
  only to resolve a specific book to OPEN it, or when a filter reports no match.
- Reply with ONE short concrete sentence confirming what you did ("Pokazuję książki z serii Droga
  Szamana."). Never invent books, ids, ratings or counts. If a search returns nothing, say so briefly.
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


# One boto3 ``bedrock-runtime`` client per region, cached for the whole process.
# Building a client is not free (it loads botocore models and resolves credentials),
# and ``run_stream`` is called once PER MODEL TURN, so a fresh client every request
# added hundreds of ms of latency to each turn. boto3 clients are thread-safe for
# calls, so one shared instance is correct.
_bedrock_clients: dict[str, Any] = {}


def _bedrock_client(region: str) -> Any:
    client = _bedrock_clients.get(region)
    if client is None:
        import boto3  # type: ignore[import-untyped]

        client = boto3.client("bedrock-runtime", region_name=region)
        _bedrock_clients[region] = client
    return client


def boto3_streamer(region: str) -> ChatBedrockStreamer:
    """Real streamer: a boto3 ``bedrock-runtime`` client driving ``converse_stream``.

    Credentials come from the standard AWS chain (SSO / env / role), never from
    ``.env``. The client is created once per region and cached (see
    :func:`_bedrock_client`) so a turn never pays client-construction latency.
    """

    def stream(
        *,
        model_id: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tool_config: dict[str, Any] | None,
    ) -> Iterator[dict[str, Any]]:
        client = _bedrock_client(region)
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


def _tool_config(tools: list[dict[str, Any]], *, cache: bool = False) -> dict[str, Any] | None:
    """Translate the browser's JSON-Schema tool list into a Bedrock ``toolConfig``.

    Each browser tool is ``{name, description, parameters}`` where ``parameters``
    is a JSON Schema object. Bedrock wants ``toolSpec.inputSchema.json``. When
    ``cache`` is set, a trailing ``cachePoint`` marks the (static) tool definitions
    as a prompt-cache prefix so they are not re-tokenised every turn.
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
    if not specs:
        return None
    if cache:
        specs.append({"cachePoint": {"type": "default"}})
    return {"tools": specs}


def _to_bedrock_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate the browser's AG-UI message list into Bedrock ``converse`` messages.

    Supported roles:
      - ``user`` / ``assistant`` with ``content`` (string) -> a text block.
      - ``assistant`` with ``toolCalls: [{id, name, args}]`` -> ``toolUse`` blocks.
      - ``tool`` with ``toolCallId`` + ``content`` -> a ``toolResult`` block
        (Bedrock requires it inside a ``user`` message).
    """
    out: list[dict[str, Any]] = []
    # When an assistant turn makes SEVERAL tool calls, Bedrock requires ALL their
    # toolResult blocks to sit in the SINGLE user message that immediately follows
    # the assistant message — not one user message per result. So consecutive
    # ``tool`` messages are merged into one user message with multiple toolResult
    # blocks; otherwise a multi-tool turn fails with "Expected toolResult blocks …".
    pending_results: list[dict[str, Any]] = []

    def _flush_results() -> None:
        if pending_results:
            out.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            tool_call_id = str(msg.get("toolCallId", "") or msg.get("tool_call_id", ""))
            content = msg.get("content", "")
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            pending_results.append(
                {
                    "toolResult": {
                        "toolUseId": tool_call_id,
                        "content": [{"text": text or "ok"}],
                    }
                }
            )
            continue

        # A non-tool message ends any run of tool results.
        _flush_results()

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
    # Any trailing tool results (the common case: the last turn's results).
    _flush_results()
    return out


def _now() -> datetime:
    """The current local date/time. A seam so the date block is testable."""
    return now()


def _date_system_block(moment: datetime | None = None) -> str:
    """The current-date system note for the UI agent.

    Built from the SHARED :func:`app.agent.dates.date_system_block` (same date rule
    both agents use), with a UI-specific tail: resolve a year/period through the
    structured library filters, never by typing a year into a free-text search box,
    and say which interpretation was used. Rebuilt every turn, so it stays correct
    across midnight in a long session.
    """
    stamp = moment or _now()
    return (
        "\n\n"
        + date_system_block(stamp)
        + " Use the structured library filters (finished year, date range, status, "
        "shelf, tag, series, author, stars) for a year or period — never type a year "
        "into a free-text search box. Say in one short line which interpretation you "
        f'used (e.g. "przeczytane w {stamp.year}").'
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


def _build_system(state: Any, *, cache: bool) -> list[dict[str, Any]]:
    """Build the Bedrock ``system`` list.

    The STATIC prompt is its own block; with ``cache`` a ``cachePoint`` follows it
    so Bedrock reuses the tokenised prefix across turns (the prompt never changes).
    The per-turn DATE and UI-STATE go in a SEPARATE trailing block AFTER the cache
    point, so changing state does not invalidate the cached prefix.
    """
    system: list[dict[str, Any]] = [{"text": SYSTEM_PROMPT}]
    if cache:
        system.append({"cachePoint": {"type": "default"}})
    dynamic = _date_system_block() + _state_system_block(state)
    system.append({"text": dynamic})
    return system


# Prompt caching is attempted first; if Bedrock rejects the cachePoint blocks for
# this model/region we disable it for the rest of the process and log once.
_prompt_cache_enabled = True
_prompt_cache_warned = False


def _looks_like_cache_rejection(exc: Exception) -> bool:
    text = str(exc).lower()
    return "cachepoint" in text or "cache point" in text or "prompt cache" in text


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
    global _prompt_cache_enabled, _prompt_cache_warned

    stream = streamer or boto3_streamer(region)

    yield {"type": RUN_STARTED, "threadId": thread_id, "runId": run_id}

    bedrock_messages = _to_bedrock_messages(messages)

    # Per-content-block assembly state.
    text_message_id: str | None = None
    tool_use_id: str | None = None
    tool_name: str | None = None
    tool_args_buf = ""

    # Per-turn metrics (item 0): time to first token, total time, Bedrock usage.
    t0 = time.monotonic()
    t_first: float | None = None
    usage: dict[str, Any] = {}
    bedrock_latency_ms: int | None = None
    tool_calls_count = 0

    def _open_stream(use_cache: bool) -> Iterator[dict[str, Any]]:
        return stream(
            model_id=model_id,
            system=_build_system(state, cache=use_cache),
            messages=bedrock_messages,
            tool_config=_tool_config(tools, cache=use_cache),
        )

    use_cache = _prompt_cache_enabled
    try:
        try:
            events = _open_stream(use_cache)
            first = next(events, None)
        except Exception as exc:  # noqa: BLE001 - may be a cachePoint rejection
            if use_cache and _looks_like_cache_rejection(exc):
                # This model/region does not support prompt caching: disable it for
                # the process, log once, and retry this turn without cache points.
                _prompt_cache_enabled = False
                if not _prompt_cache_warned:
                    _prompt_cache_warned = True
                    logger.warning("Bedrock prompt caching unavailable; continuing without it")
                use_cache = False
                events = _open_stream(False)
                first = next(events, None)
            else:
                raise

        def _all_events() -> Iterator[dict[str, Any]]:
            if first is not None:
                yield first
            yield from events

        for event in _all_events():
            if "metadata" in event:
                meta = event.get("metadata", {})
                usage = meta.get("usage", {}) or usage
                metrics = meta.get("metrics", {})
                if isinstance(metrics, dict) and "latencyMs" in metrics:
                    bedrock_latency_ms = metrics.get("latencyMs")
                continue
            if "contentBlockStart" in event:
                start = event["contentBlockStart"].get("start", {})
                tool_use = start.get("toolUse")
                if tool_use:
                    if t_first is None:
                        t_first = time.monotonic() - t0
                    tool_calls_count += 1
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
                    if t_first is None:
                        t_first = time.monotonic() - t0
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
            # messageStart / messageStop carry no AG-UI payload we surface.
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

    # One INFO line per model turn (item 0): timings + Bedrock token usage. The
    # usage dict carries cacheReadInputTokens / cacheWriteInputTokens when prompt
    # caching is active, so the log shows whether the cache is being hit.
    total_ms = int((time.monotonic() - t0) * 1000)
    ttft_ms = int(t_first * 1000) if t_first is not None else None
    logger.info(
        "ui_agent turn run=%s ttft_ms=%s total_ms=%s bedrock_latency_ms=%s "
        "in_tokens=%s out_tokens=%s cache_read=%s cache_write=%s tool_calls=%s cache=%s",
        run_id,
        ttft_ms,
        total_ms,
        bedrock_latency_ms,
        usage.get("inputTokens"),
        usage.get("outputTokens"),
        usage.get("cacheReadInputTokens"),
        usage.get("cacheWriteInputTokens"),
        tool_calls_count,
        use_cache,
    )

    yield {"type": RUN_FINISHED, "threadId": thread_id, "runId": run_id}
