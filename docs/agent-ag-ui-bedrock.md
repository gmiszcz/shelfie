# Agent Layer — AG-UI frontend tools, AWS Bedrock, AWS Transcribe

Shelfie has **two chat agents**, switched in the chat widget header:

- **Library agent** — a read-only data assistant that answers questions about the library. It runs
  **on the server** (Strands Compose + Bedrock) with database tools, and streams its answer to the
  browser over SSE. Endpoint: `POST /api/agent/chat`. (Unchanged; see "Library agent" below.)
- **UI agent** — an assistant that **drives the user interface**. It follows the **AG-UI
  frontend-tools** pattern (as in CopilotKit / the AG-UI client): **its tools are defined and
  executed in the browser**. The only server part is a thin LLM runner, because Bedrock credentials
  cannot live in the browser. Endpoint: `POST /api/agui/run`.

Both run on **AWS Bedrock** (Claude Haiku 5.5, `eu-central-1`). Voice input (AWS Transcribe) works
in either mode.

## Why frontend tools, and why they are now universal

The first design put "UI tools" on the **server** as stub functions and tried to turn the model's
tool call into a UI event after the fact. In the real app the agent often just **said it could not
change the UI**. The second design moved every tool into the browser but still hand-wrote one tool
per action (`set_search`, `set_star_filter`, …) plus a matching case in a `shelfie:ui` bus — so
**adding a tab or control meant editing the agent**.

The UI agent is now **universal (registry-driven)**:

- Controls **declare themselves** at runtime with `useAgentAnchor(...)` (see
  [ui-agent-registry.md](features/ui-agent-registry.md)). Each **anchor** is one addressable control
  with a stable id, a kind, a label, and live accessors (`getState` / `set` / `invoke` / `options` /
  `items`).
- The browser owns a small set of **generic** tools — `describe_ui`, `get_state`, `set`, `invoke`,
  `navigate`, plus the client-side `find_books`. No tool knows any specific control.
- `describe_ui()` builds the whole **navigation schema on the fly** from the live registry (tabs →
  anchors with kind, label, current value, allowed options, actions; lists expose their items).
- The server still **never** runs a tool and has **no database access**. It relays the browser's
  generic tool schemas and the live UI schema to Bedrock and streams events back, and it injects the
  **current date/time** so relative periods ("this year") resolve without asking the user.

Adding a tab or a control is now purely a `useAgentAnchor` call in that component — the agent, its
tools and the backend are untouched.

```mermaid
flowchart LR
    U[User] --> CW[ChatWidget\nUI agent mode]
    COMP[Any component\nuseAgentAnchor&#40;...&#41;] -->|register / unregister| REG[(Anchor registry\nfrontend/src/agent-ui)]
    CW -->|POST /api/agui/run\n{messages, generic tools, describe_ui&#40;&#41; schema}| R[Thin runner\napp/agent/ui_agent.py\n+ current date]
    R -->|converse_stream| B[(Bedrock\nHaiku 5.5)]
    B -->|AG-UI events| R --> CW
    CW -->|model called set/invoke/navigate&#40;id&#41;| EX[Browser tool executor\nfrontend/src/agui/tools.ts]
    EX -->|setAnchor / invokeAnchor| REG
    REG -->|anchor.set / anchor.invoke| COMP
    EX -->|tool result message| CW
    CW -->|next POST /api/agui/run| R
```

## The run loop (one message → many turns)

`frontend/src/agui/client.ts` (`runAgent`) drives the loop:

1. POST `{threadId, runId, messages, tools, state}` to `/api/agui/run`.
   - `messages` is the running AG-UI conversation (`user` / `assistant` / `tool`).
   - `tools` is the generic JSON-Schema list from `frontend/src/agui/tools.ts`.
   - `state` is the live UI schema from `describeUi()` (the anchor registry), so the first turn
     already knows the screen even before the model calls `describe_ui`.
2. The runner streams AG-UI events; the client collects streamed text and **at most one tool call**.
3. If the model answered with **text only** → the run is done.
4. If the model emitted a **tool call** → the browser **executes it**, appends the result as a
   `tool` message, and goes back to step 1.

The loop stops on a text answer, on `RUN_ERROR`, on abort, or at a `maxTurns` safety cap.

### AG-UI events (the wire, `POST /api/agui/run`)

The runner (`app/agent/ui_agent.py`) emits, per turn:

| Event | When |
|---|---|
| `RUN_STARTED` | first, carries `threadId` / `runId` |
| `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` | the model writes prose (`delta` carries the text) |
| `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` | the model calls a browser tool; `TOOL_CALL_END` carries the full JSON `args` |
| `RUN_FINISHED` | last (success) |
| `RUN_ERROR` | last (failure, carries `message`) — e.g. missing Bedrock credentials |

A turn that emits a tool call **ends right after it** (`TOOL_CALL_END` → `RUN_FINISHED`); the browser
runs the tool and starts the next turn. This is the AG-UI frontend-tools contract.

The system prompt tells the model to **call `describe_ui` first**, to act through `set` / `invoke` /
`navigate` using only ids from the schema, to resolve names with `find_books`, to use the structured
filters (never type a year into a search box), and to confirm briefly what it did.

## Browser tools (`frontend/src/agui/tools.ts`) — generic, registry-driven

Every tool runs in the browser and is **generic**: it reads or drives the runtime anchor registry
(`frontend/src/agent-ui/`), so it works for any current or future control with no change.

| Tool | Effect |
|---|---|
| `describe_ui()` | Build the whole UI schema from the live registry (tabs → anchors with kind, label, current value, allowed options, actions; lists expose items). Call first. |
| `get_state(id)` | Read one anchor's current value. |
| `set(id, value)` | Set a value control (text-input / search / select / toggle / multi-select); validated against the anchor's options. |
| `invoke(id, action?, args?)` | Act on a button / dialog / list item (e.g. open a book, open/close a dialog, apply a filter). |
| `navigate(tab)` | Switch the active tab. |
| `find_books(query, limit?)` | Search the **already-loaded** books → `{ id, title, authors, series, stars, display_score }[]`. |

## Anchor registry (`frontend/src/agent-ui/`)

Controls register with `useAgentAnchor({ id, kind, label, description?, tab?, getState?, set?,
invoke?, options?, items?, actions? })` on mount and unregister on unmount. `describeUi()` builds the
schema from the live set; `setAnchor` / `invokeAnchor` / `navigate` act on it with validation (an
error lists the valid ids or option values). Allowed values for selects (years, shelves, tags,
series, authors, statuses) are **derived from the loaded data**, so they are always correct. The full
contract, the shipped anchors, the date-awareness and the structured library filters are documented
in [features/ui-agent-registry.md](features/ui-agent-registry.md). The old `shelfie:ui` CustomEvent
bus and the `window.__shelfieUiState` snapshot have been removed — the registry replaces both.

## Chat widget (`frontend/src/components/ChatWidget.tsx`)

The header has a clear **mode switch**: **Library agent** vs **UI agent**. Switching starts a fresh
conversation (the two agents keep separate histories). In UI mode the widget runs `runAgent`, renders
streamed text, and shows each executed tool as a small **action card** (running → success/error). It
keeps a cached book list for `find_books` and the AG-UI message history across turns. In Library mode
it uses the existing backend SSE stream unchanged.

## Verified live against Bedrock

A dev server (`uv run python -m uvicorn app.main:app --port 8099`) and the live integration test
`frontend/src/agui/live.test.ts` (run with `AGUI_LIVE=1 AGUI_BASE=http://127.0.0.1:8099 npx vitest run
src/agui/live.test.ts`) register anchors mirroring the app and drive the **full browser loop** against
**real Bedrock** through the generic tools. The observed behaviour (also verified in the browser with
Playwright against the live backend):

| Prompt (Polish) | What the model did | Result |
|---|---|---|
| „pokaż książki z serii Droga Szamana” | `describe_ui` → `find_books` → `invoke(library.filter, apply, {series})` | grid filtered to the series |
| „przejdź do statystyk i pokaż ostatnie 12 miesięcy” | `navigate(stats)` → `set(stats.period, "last12Months")` | Statistics tab, period changed |
| „w rankingu wyszukaj Sanderson” | `navigate(ranking)` → `set(ranking.search, "Sanderson")` | ranking search filled |
| „włącz w ustawieniach liczbę stron na kartach” | `set(settings.cardFields.pageCount, true)` | page-count card field on |
| „chcę dodać książkę Diuna” | `invoke(library.addBook, search, {query:"Diuna"})` | add-search dialog prefilled |
| „pokaż książki z tego roku” | `invoke(library.filter, apply, {finished_year: <current>})` | finished-this-year, chip shows it, count matches DB |
| „pokaż przeczytane w 2025” | `invoke(library.filter, apply, {finished_year: 2025})` | finished-2025, count matches DB |
| „pokaż fantasy z 2024” | `invoke(library.filter, apply, {shelf:"Fantasy", finished_year:2024})` | shelf + year, structured chip |

No year ever went into the free-text search box — the model picks the structured `finished_year`
facet because the injected date block tells it "this year" means `finished_on` in the current year.

The live test is skipped unless `AGUI_LIVE` is set, so it never runs in `just check`. The client loop
is also unit-tested with a **fake fetch** (`frontend/src/agui/client.test.ts`): a scripted
`find_books → invoke(library.filter) → answer` sequence, a `RUN_ERROR` stop, and the `maxTurns` cap.
The registry, the generic tools and the anchor-coverage guard are unit-tested in
`frontend/src/agent-ui/*.test.*`, `frontend/src/agui/tools.test.ts` and `frontend/src/App.test.tsx`.

## Library agent (unchanged, `POST /api/agent/chat`)

The library agent is the existing Strands Compose assistant (`app/agent/engine.py`,
`app/agent/tools.py`, `app/agent/config.yaml`). It runs on the server with read-only database tools
(`search_library`, `get_book_details`, `list_books`, `reading_stats`, `library_overview`) and streams
a small wire protocol annotated with AG-UI names (`app/agent/agui.py`). The chat widget's **Library
agent** mode uses it with `scope: "library"`.

## Voice input (AWS Transcribe streaming)

Unchanged from wave 2: a mic button records audio, downsamples to 16 kHz 16-bit mono PCM and streams
it to `/api/transcribe/stream` (WebSocket), which drives Amazon Transcribe and returns partial/final
transcripts; the final text is appended to the input box (pl-PL default, en-US toggle). See
`frontend/src/chat/useVoiceInput.ts`, `app/api/routes/transcribe.py`, `app/services/transcribe.py`.

## Files

- `app/agent/ui_agent.py` — thin Bedrock runner (`run_stream`): request → `converse_stream` → AG-UI events; injects the current date. **No DB tools.**
- `app/api/routes/agui.py` — `POST /api/agui/run` (SSE).
- `frontend/src/agent-ui/` — the anchor registry: `types.ts`, `registry.ts` (`describeUi`/`setAnchor`/`invokeAnchor`/`navigate`), `useAgentAnchor.ts`.
- `frontend/src/agui/client.ts` — the browser run loop (`runAgent`); sends the `describeUi()` schema as `state`.
- `frontend/src/agui/tools.ts` — the generic browser tools (`describe_ui`/`get_state`/`set`/`invoke`/`navigate`/`find_books`).
- `frontend/src/settings/libraryFilter.ts` — the structured library filter + data-derived option helpers.
- `frontend/src/agui/events.ts` — AG-UI event types + SSE parser.
- `frontend/src/agui/labels.ts` — action-card labels.
- `frontend/src/components/ChatWidget.tsx` — Library-vs-UI mode switch, action cards.
- `app/agent/engine.py` / `app/agent/agui.py` / `app/agent/tools.py` — the Library agent (backend-owned).

## Voice input (hands-free, wave 3)

The microphone is now **hands-free and self-stopping** — it no longer records until you manually
stop. It lives in a dedicated `MicButton` component; `ChatWidget` only mounts `<MicButton … />` and
wires one callback.

### Controls

| Action | Effect |
| --- | --- |
| Click the mic (idle) | Start recording |
| Click the mic (recording) | **Stop** — the transcript drops into the input box for review |
| `Ctrl+M` | Toggle start/stop. Works while the app is focused even when the chat is closed — the panel opens first, then recording starts. |
| `Esc` (while recording) | **Cancel** — stop and discard, send nothing |
| Stop talking (after speech) | Auto-stop **and auto-send** after ~1.5 s of silence |
| Say nothing | Auto-stop (no send) after ~8 s of silence |

### End-of-speech detection — the VAD state machine

The stop/send decision is a **pure state machine** in `frontend/src/chat/voiceMachine.ts`
(`voiceMachineStep(state, input, config)`), with no browser or React dependency, so it is unit-tested
by feeding synthetic RMS frames and transcript events (`frontend/src/chat/voiceMachine.test.ts`).

Inputs are `start` / `stop` / `cancel`, audio `frame`s (each carrying the frame's **RMS level** from
a local VAD), `transcript` events (partial/final from the backend), and a periodic `tick`. Each step
returns the next state plus `effect`s (`teardown`, or `final { text, autoSend }`). Rules, all driven
by configurable constants:

- A frame with `rms >= VAD_RMS_THRESHOLD` (0.015) counts as speech and refreshes the silence timer.
- With at least one **final** transcript, `SILENCE_AFTER_SPEECH_MS` (1500 ms) of silence ends the
  utterance and emits `final { autoSend: true }` → ChatWidget sends immediately.
- With nothing ever said, `SILENCE_NO_SPEECH_MS` (8000 ms) stops recording with no `final` effect.
- A manual stop emits `final { autoSend: false }` (text goes to the input box); `cancel` emits none.

`useVoiceInput` is the impure shell: it computes `frameRms` per audio frame, feeds the machine on a
150 ms clock tick, and translates the machine's effects into side effects. It exposes
`onFinal(text, { autoSend })`, `start`, `stop`, `cancel` and `toggle`.

### Visual feedback

- A **live glow ring** around the mic button, driven by a CSS custom property `--mic-level` (0..1)
  that the hook updates from a smoothed RMS level via `requestAnimationFrame`. The ring uses theme
  colours and the recording state is red. Under `prefers-reduced-motion: reduce` the rAF loop is not
  started and the pulse animation is disabled, so the ring simply holds steady.
- The **partial transcript** is shown live just above the input while recording.
- A tooltip surfaces the `Ctrl+M` (and `Esc` to cancel) hints.

### Clean teardown (no dangling stream, mic released)

`useVoiceInput`'s `cleanup` runs on every stop/cancel/error and on unmount. It clears the tick and
rAF loops, disconnects the `ScriptProcessor` and source nodes, closes the `AudioContext`, stops every
`MediaStreamTrack` (so the browser's recording indicator turns off), sends `{"action":"stop"}` and
closes the WebSocket. On the backend, the `/api/transcribe/stream` route feeds a `None` sentinel into
the audio generator on stop/disconnect and awaits the transcription task with a 10 s timeout before
cancelling it, so the Amazon Transcribe stream is always ended — verified by
`tests/test_transcribe.py` (clean close on stop, clean close on disconnect, cancellation of a hanging
stream).

### Files (wave 3)

- `frontend/src/chat/voiceMachine.ts` (+`.test.ts`) — pure VAD + stop/send state machine.
- `frontend/src/chat/useVoiceInput.ts` (+`.test.ts`) — mic capture, VAD driving, teardown.
- `frontend/src/components/MicButton.tsx` (+`.css`) — the mic button, glow ring and shortcuts.
- `frontend/src/components/ChatWidget.tsx` — mounts `<MicButton>` and wires `onFinal`.

## 2026-11-08 — UI-agent bug fixes and turn-latency work

Three reported bugs were fixed and the UI agent's per-turn latency was cut. All work is on
`feat/ui-agent-fixes`.

### Bug 1 — "pokaż ulubione książki" switched tab but showed nothing

Root cause: the `nav.tab` anchor's `invoke` in `App.tsx` only handled a hand-picked subset of tabs
(`library` / `stats` / `ranking`). `navigate('favourites')` (and `series`) passed the registry's
tab validation and returned `ok: true`, but `setPage` was never called — the tab never switched and
the Favourites anchors never mounted, so the agent "opened" a tab that stayed on Library. Fix:
`nav.tab.invoke` now accepts **every** tab present in `PAGES` (the admin-only `users` page stays
deliberately absent). Regression tests in `App.test.tsx` assert navigation to every nav tab and that
Favourites then exposes `favourites.books`.

### Bug 3 — mic toast "Tap to open in chat" opened an EMPTY conversation

Root cause: `GlobalMic.openInChat` called `switchMode('ui')`, and `switchMode` starts a clean
conversation (`newChat()` → reducer `reset` + clears `uiMessagesRef`). Since the head-less mic run
left the panel in `library` mode, the switch to `ui` reset the shared thread, so the spoken exchange
was lost. Fix: a new `revealUiChat()` on the chat context sets mode to `ui` and opens the panel
**without** resetting; `GlobalMic` taps that instead of `switchMode`. `GlobalMic.test.tsx` asserts
the thread's message count is unchanged after tapping.

### Bug 2 — partial answers, long "thinking", then an error

Several causes compounded as the shared thread grew:

- **toolUse/toolResult pairing (the error).** When the model made several tool calls in one turn,
  the client kept only the LAST call (it overwrote `outcome.toolCall` on each `TOOL_CALL_END`), and
  the backend emitted one `user` message per tool result. Bedrock requires every `toolUse` of an
  assistant turn to be answered by a `toolResult` in the SINGLE following `user` message, so the
  next request failed with `ValidationException: Expected toolResult blocks …`. Fixes: the client
  now collects and executes ALL tool calls of a turn and appends a result for each
  (`frontend/src/agui/client.ts`); the backend merges consecutive tool-result messages into one
  `user` message with multiple `toolResult` blocks (`_to_bedrock_messages` in
  `app/agent/ui_agent.py`).
- **Extra turns.** The system prompt forced `describe_ui` first even though the client already sends
  the live UI schema as `state` every turn; and the confirmation sentence was written in a separate
  turn. Fixes: the prompt tells the model it already holds the schema (call `describe_ui` only after
  `navigate`), and the client ends the loop when a turn produced text AND every tool succeeded
  (continuing on a tool error so the model can correct itself).
- **Oversized per-turn payload.** `list` anchors sent their full item list twice (as `value` AND
  `items`); facet selects (authors/series/tags/shelves) sent hundreds of options every turn; and the
  thread re-sent every old tool result including whole `describe_ui` dumps. Fixes: the registry drops
  `value` for lists, caps options at `OPTION_CAP = 20` with a note pointing to `find_books`, and
  `ChatProvider` trims older tool results to `[omitted]` keeping the last 6 exchanges.
- **`library.filter` name resolution.** It now accepts a plain human name for series/author/shelf/tag
  and resolves it to the real value itself (case/diacritics/inflection tolerant, via `resolveFacet`
  in `settings/libraryFilter.ts`), so a normal filter no longer needs a `find_books` round-trip.

### Backend latency and observability

- **One boto3 client per region**, cached at module level (was rebuilt every turn).
- **Non-blocking SSE**: the route returns a SYNC generator so Starlette iterates the blocking
  `converse_stream` in its threadpool, instead of an `async def` that froze the event loop for the
  whole turn.
- **Prompt caching**: a Bedrock `cachePoint` follows the static system prompt and the tool
  definitions; the date and UI-state snapshot go in a SEPARATE trailing system block so changing
  state never invalidates the cached prefix. If the model/region rejects cache points the runner
  disables them for the process, logs once, and retries without.
- **Per-turn metrics**: one INFO line per model turn — `ttft_ms`, `total_ms`, Bedrock `latencyMs`,
  `inputTokens` / `outputTokens`, `cacheRead/Write` tokens, tool-call count.

### Measured turns-per-command and latency (live Haiku, copied data, shared thread)

| Command | Before | After |
| --- | --- | --- |
| pokaż ulubione książki | 4 turns / 7.5 s | 2 turns / 4.7 s |
| pokaż książki fantasy z 2025 | 8 turns / 22 s → **error** (`did not finish within 8 turns`) | 3 turns / 8.0 s |
| przejdź do statystyk i pokaż ostatnie 12 miesięcy | 4 turns / 7.5 s | 3 turns / 4.8 s |

The fantasy command previously looped to the turn cap and failed; it now completes in 3 turns with no
error. Individual turns run ~1.4–3.2 s (the first turn of a command carries the cold path).

### Files

- `frontend/src/App.tsx` — `nav.tab.invoke` accepts every tab (bug 1).
- `frontend/src/chat/ChatProvider.tsx` — `revealUiChat` (bug 3); `trimUiHistory` (item 3); early
  action pill wiring.
- `frontend/src/components/GlobalMic.tsx` — toast tap uses `revealUiChat`.
- `frontend/src/chat/chatState.ts` — `action_label` action (early pill + later label refine).
- `frontend/src/agui/client.ts` — collect/execute ALL tool calls per turn; end on text+all-ok;
  `onToolCallStart` callback.
- `frontend/src/agent-ui/registry.ts` + `types.ts` — drop `value` for lists, cap options
  (`OPTION_CAP`), `optionsTotal`/`note`.
- `frontend/src/pages/Library.tsx` + `settings/libraryFilter.ts` — tolerant facet name resolution.
- `app/agent/ui_agent.py` — cached client, split/cacheable system blocks, metrics log, multi-tool
  result merge, shorter prompt without the "describe_ui first" rule.
- `app/api/routes/agui.py` — sync generator (threadpool) for non-blocking SSE.


## 2026-11-08 — librarian link (ask_librarian), read-only scope, shared date, thinking off

The UI agent (browser tools) could drive the screen but could not answer DATA questions
("ile przeczytałem w tym roku", counts, stats). It now delegates every data question to
the backend librarian through one browser tool, with a server-enforced read-only scope.

### `ask_librarian(question)` — the only new browser tool

- Defined in `frontend/src/agui/tools.ts` alongside the generic UI tools. Its executor
  calls an injected `askLibrarian(question, signal)` (host-provided, so `tools.ts` stays
  decoupled from the SSE transport) and returns `{ ok: true, final_answer: true, answer }`.
- `frontend/src/agui/client.ts` recognises a tool result carrying `final_answer: true`
  (`finalAnswerOf`): it ends the run loop immediately and surfaces `answer` as the reply
  **verbatim, with no extra model turn**. The assistant/tool messages are still recorded,
  so the thread stays consistent for the next command.
- `frontend/src/chat/ChatProvider.tsx` supplies `askLibrarian`: it keeps **one read-only
  librarian session per UI-agent thread** (`librarianSessionRef`, id `lib-<thread>`), POSTs
  `/api/agent/chat` with `scope: "library_readonly"`, and reads the SSE stream with the
  existing `readChatStream` + `api.chat` to the final `session_finish` text. The librarian
  session is reset together with the UI thread in `newChat` (both scopes dropped server-side).
- Action pill: `describeAction('ask_librarian', …)` → "Asking the librarian…"
  (`frontend/src/agui/labels.ts`), shown the instant the call starts.
- UI system prompt (`app/agent/ui_agent.py`) now routes: any DATA question → `ask_librarian`
  and stop (do not paraphrase, do not take another turn); screen actions → the UI tools.

### Read-only scope — enforced server-side, not just in the prompt

- New chat scope `library_readonly` (`app/api/routes/agent.py` widens the `scope` literal;
  the legacy `ui` value is still accepted and treated as `library`).
- `app/agent/engine.py`: `_apply_scope` prunes every tool NOT in `READONLY_TOOLS` from the
  resolved agent's `tool_registry`, so a read-only session has no write tool at all — the
  model cannot call what it does not have. `READONLY_TOOLS` = search_library, get_book,
  get_book_details, list_books, reading_stats, library_overview, list_series, get_series,
  list_favourites, list_waiting_list, series_alerts. A `_readonly_prompt_note()` also tells
  it to refuse changes. Sessions are keyed by `(user_id, scope, session_id)` so a read-only
  session never aliases a read+write one with the same id.

### Shared current-date note (fixes "which year is it?")

- New `app/agent/dates.py` (`now`, `date_system_block`) is the single source of the
  "today is YYYY-MM-DD, current year N, this year = finished_on in N, never ask the year"
  rule, used by BOTH agents. `ui_agent._date_system_block` reuses it and adds its UI tail.
  `engine.ChatEngine._apply_date_prompt` injects it into the librarian's system prompt **in
  code at each reply**, rebuilt from the live clock every turn, so a long session stays
  correct across midnight.

### Live check (temp copy of data, zero Google Books calls)

Detached backend on 127.0.0.1:8035, `DATA_DIR`/`AUTH_DB_PATH` → a scratch COPY of the
library, `GOOGLE_BOOKS_MAX_CALLS=0`, `AWS_EC2_METADATA_DISABLED=true`. A scripted driver ran
the UI-agent loop:

- "ile książek przeczytałem w tym roku?" → **1 UI turn + ask_librarian** → "W 2026 roku
  przeczytałeś 5 książek …" (DB: 5 finished in 2026). Correct year resolved with no question.
- "a w 2025?" (follow-up, same librarian session) → **1 UI turn + ask_librarian** → "W 2025
  roku przeczytałeś 40 książek" (DB: 40). Context carried.
- "usuń Diunę" via ask_librarian → refused ("tryb tylko do odczytu, nie mam narzędzi do
  zmiany"); the copied DB was unchanged (208 total, 5/40 by year). Read-only holds.

### Files

- `app/agent/dates.py` (new), `app/agent/engine.py`, `app/agent/ui_agent.py`,
  `app/agent/config.yaml` (thinking removed), `app/api/routes/agent.py`.
- `frontend/src/agui/tools.ts`, `frontend/src/agui/client.ts`, `frontend/src/agui/labels.ts`,
  `frontend/src/chat/ChatProvider.tsx`, `frontend/src/services/api.ts`.
