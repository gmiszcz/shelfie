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
