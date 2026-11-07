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

## Why frontend tools (what changed)

The previous design put "UI tools" on the **server** as stub functions and tried to turn the model's
tool call into a UI event after the fact. In the real app the agent often just **said it could not
change the UI**. The UI agent fixes this by making the browser the source of truth:

- The browser **owns** every UI tool — both its JSON-Schema definition (sent to the model) and its
  **executor** (run locally). The tool's effect is a real DOM action: it dispatches a `shelfie:ui`
  bus event, waits for the listener's ack, reads `window.__shelfieUiState`, or searches the books the
  app already loaded.
- The server **never** runs a tool and has **no database access**. It only relays the browser's tool
  schemas to Bedrock and streams events back.

```mermaid
flowchart LR
    U[User] --> CW[ChatWidget\nUI agent mode]
    CW -->|POST /api/agui/run\n{messages, tools, state}| R[Thin runner\napp/agent/ui_agent.py]
    R -->|converse_stream| B[(Bedrock\nHaiku 5.5)]
    B -->|AG-UI events| R --> CW
    CW -->|model called a tool| EX[Browser tool executor\nfrontend/src/agui/tools.ts]
    EX -->|shelfie:ui CustomEvent| L[App / Library listeners]
    L -->|shelfie:ui:ack| EX
    EX -->|tool result message| CW
    CW -->|next POST /api/agui/run| R
```

## The run loop (one message → many turns)

`frontend/src/agui/client.ts` (`runAgent`) drives the loop:

1. POST `{threadId, runId, messages, tools, state}` to `/api/agui/run`.
   - `messages` is the running AG-UI conversation (`user` / `assistant` / `tool`).
   - `tools` is the JSON-Schema list from `frontend/src/agui/tools.ts`.
   - `state` is a snapshot of `window.__shelfieUiState`.
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

The system prompt tells the model to answer in the user's language, to **act instead of describing**,
to resolve names with `find_books` first, and to confirm briefly what it did.

## Browser tools (`frontend/src/agui/tools.ts`)

Every tool runs in the browser. `navigate`, `set_search`, `set_star_filter`, `filter_library`,
`clear_filter`, `open_book`, `open_add_book`, `open_settings`, `set_setting`, `toggle_theme` and
`ranking_search` dispatch a `shelfie:ui` event and await its ack; `get_ui_state` reads
`window.__shelfieUiState`; `find_books` searches the **already-loaded** books (title / author /
series / shelf / tags / insights) and returns ids + titles so the model can then filter or open them.

| Tool | Effect |
|---|---|
| `navigate(tab)` | switch tab: `library` / `stats` / `ranking` |
| `set_search(query)` | type into the library search box (navigates to library) |
| `set_star_filter(stars)` | whole-star filter 1..5, or `null` to clear |
| `filter_library(query?, series?, author?, shelf?, tag?, status?, min_stars?, book_ids?)` | filter the grid |
| `clear_filter()` | remove the assistant filter |
| `open_book(book_id)` | open the detail dialog |
| `open_add_book(mode, query?, prefill?)` | open the Google-search dialog (query typed) or the manual form (prefilled) |
| `open_settings()` | open the settings sidebar |
| `set_setting(key, value)` | toggle a card field / detail section / `showAllDetails` |
| `toggle_theme()` | dark ↔ light |
| `ranking_search(query)` | type into the ranking search box (navigates to ranking) |
| `get_ui_state()` | read the current UI state snapshot |
| `find_books(query, limit?)` | search the loaded books → `{ id, title, authors, series, stars, display_score }[]` |

## UI bus contract v2 (`frontend/src/agui/bus.ts`)

A tool drives the app with a `window` CustomEvent `shelfie:ui` whose `detail` is one of the
`UiBusDetail` shapes (the wave-2 events plus `set_search`, `set_star_filter`, `open_add_book`,
`open_settings`, `close_dialogs`, `set_setting`, `toggle_theme`, `ranking`). The listener (App /
Library, owned by library-fixes) handles it and **must answer** with a `shelfie:ui:ack` CustomEvent
carrying `{ action, ok, info? }`. `dispatchAndWait()` resolves on the ack, or after a short timeout
treats the action as done (so a missing listener degrades gracefully rather than hanging the loop).
A read-only snapshot lives on `window.__shelfieUiState = { tab, search, starFilter, assistantFilter,
settings, visibleBookIds, openDialog }`.

## Chat widget (`frontend/src/components/ChatWidget.tsx`)

The header has a clear **mode switch**: **Library agent** vs **UI agent**. Switching starts a fresh
conversation (the two agents keep separate histories). In UI mode the widget runs `runAgent`, renders
streamed text, and shows each executed tool as a small **action card** (running → success/error). It
keeps a cached book list for `find_books` and the AG-UI message history across turns. In Library mode
it uses the existing backend SSE stream unchanged.

## Verified live against Bedrock

A dev server on port 8099 (`uv run python -m uvicorn app.main:app --port 8099`) and the live
integration test `frontend/src/agui/live.test.ts` (run with `AGUI_LIVE=1 AGUI_BASE=http://127.0.0.1:8099
npx vitest run src/agui/live.test.ts`) drive the **full browser loop** against **real Bedrock**. The
observed tool/event sequences:

| Prompt (Polish) | Tool sequence | Final text |
|---|---|---|
| „pokaż książki z serii Droga Szamana” | `find_books{query:"Droga Szamana"}` → `filter_library{series:"Droga Szamana"}` | „Pokazuję 3 książki z serii Droga Szamana.” |
| „chcę dodać książkę Diuna” | `open_add_book{mode:"search", query:"Diuna"}` | „Otworzyłem wyszukiwarkę książek z hasłem „Diuna”…” |
| „pokaż tylko 5 gwiazdek” | `set_star_filter{stars:5}` | „Pokazuję tylko książki z oceną 5 gwiazdek.” |
| „przejdź do rankingu” | `navigate{tab:"ranking"}` | „Przeszedłem do rankingu.” |

Each run streamed `RUN_STARTED → TOOL_CALL_START/ARGS/END → RUN_FINISHED`, the browser executed the
tool and acked it, the tool result was fed back, and a final turn produced
`RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED` with the Polish confirmation above.

The live test is skipped unless `AGUI_LIVE` is set, so it never runs in `just check`. The client loop
is also unit-tested with a **fake fetch** (`frontend/src/agui/client.test.ts`): a scripted
find_books → filter_library → answer sequence, a `RUN_ERROR` stop, and the `maxTurns` cap.

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

- `app/agent/ui_agent.py` — thin Bedrock runner (`run_stream`): request → `converse_stream` → AG-UI events. **No DB tools.**
- `app/api/routes/agui.py` — `POST /api/agui/run` (SSE).
- `frontend/src/agui/client.ts` — the browser run loop (`runAgent`).
- `frontend/src/agui/tools.ts` — browser tool definitions + executors.
- `frontend/src/agui/bus.ts` — UI bus v2 types, `dispatchAndWait` (+ ack), `readUiState`.
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
