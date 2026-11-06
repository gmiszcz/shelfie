# Agent Layer — Strands Compose, AG-UI/A2UI, AWS Bedrock, AWS Transcribe

Shelfie's AI layer lets the user search, add, and curate the library by chat and voice. It runs on
**AWS Bedrock** via **Strands Compose** (declarative YAML multi-agent orchestration), exposes
backend operations as **MCP tools**, coordinates background work over **A2A**, and streams a live,
agent-driven interface to the frontend over **AG-UI / A2UI**.

Built with the `strands-compose-builder` and `ai-strands-agents-documentation` skills.

## Pieces

| Piece | Role |
|---|---|
| **AWS Bedrock** | Hosts the foundation models the agents run on |
| **Strands Compose** | Declarative YAML orchestration on top of strands-agents (models, agents, tools, hooks, sessions, streaming) |
| **MCP** | Backend operations (search, add book, set rating, run comparison) exposed as agent tools |
| **A2A** | Agent-to-agent coordination for background tasks (bulk enrich, recalibration) |
| **AG-UI / A2UI** | Frontend protocol: the agent renders/updates UI, shows tool calls, requests confirmation |
| **AWS Transcribe** | Streaming speech-to-text for voice control |

## Orchestration (Strands Compose)

Config is YAML; `agents` + `entry` are the only required keys. Shelfie starts with a **delegate**
orchestration: one entry agent that calls specialists as tools.

```yaml
# Illustrative — not final.
agents:
  librarian:                       # entry: understands the user, delegates
    system_prompt: "You help manage a personal book library."
  cataloger:                       # finds and enriches books via MCP tools
    system_prompt: "You look up books and normalize metadata."
  curator:                         # runs rating / comparison flows
    system_prompt: "You help rank and compare favorite books."
entry: librarian
```

Mode choice (from the skill's decision guide):
- **delegate** — entry agent calls specialists as tools (our start).
- **swarm** — peers hand off autonomously (if the layer grows).
- **graph** — fixed pipeline with optional revision loops (e.g. a batch enrich-then-verify job).

## Tools over MCP

The agents never touch the database directly — they call **MCP tools** that wrap the backend's own
API endpoints. So the agent has exactly the capabilities a user has, with no privileged side door.
Tools map to existing routes:

- `search_books(query)` → Google Books search
- `add_book(volume_id | isbn)` → create a `Book`
- `set_reading_status(book_id, status)`
- `rate_book(book_id, stars)` → may enqueue a comparison session
- `start_comparison_session(book_id)` / `record_comparison(session_id, winner)`

MCP servers can run managed, over a URL, or via stdio (per the skill); the backend hosts the Shelfie
tool server.

## Background coordination over A2A

Longer jobs — bulk-enriching an imported library, periodic rating recalibration — run as background
agents that coordinate over **A2A**, reporting progress back through the stream rather than blocking
the user's chat.

## Frontend streaming (AG-UI / A2UI)

Strands Compose wires an event queue to a transport; Shelfie surfaces it to the browser over
**SSE/WebSocket**. The frontend speaks **AG-UI / A2UI**:

- **Dynamic rendering:** the agent emits UI component descriptors that the frontend renders as
  PrimeReact components (e.g. a result grid, a comparison card).
- **Tool-call previews:** each tool call the agent makes is shown live in the UI.
- **UI state control:** the agent can update interface state (open a dialog, preselect a filter).
- **Human-in-the-loop:** before a consequential action (delete, bulk change, a purchase-like step)
  the agent pauses and the UI asks the user to confirm; the answer flows back into the agent turn.

Event flow: `agent turn → Strands Compose event queue → backend SSE/WebSocket → AG-UI client →
Redux → PrimeReact`.

## Voice (AWS Transcribe)

The browser captures microphone audio and streams it to **AWS Transcribe** for real-time
transcription; the transcript becomes the agent prompt. The same AG-UI stream renders the agent's
response, so voice and text share one path.

## Sessions

Per the skill, multi-tenant servers load config once and resolve a session per request
(`load_config()` → `resolve_infra()` → `load_session(session_id=...)`). Shelfie uses this seam so
conversations are isolated per user once multi-tenant auth is on; single-user now uses a fixed
session id.

## Deployment

- **Local dev:** `sca dev --config config.yaml`, or `create_app("config.yaml").run()` mounted into
  the FastAPI backend.
- **Production:** deploy to **AWS Bedrock AgentCore** via `strands-compose-agentcore`
  (`create_app(...)` in `main.py` + `agentcore deploy`); invoke with `AgentCoreClient`.

AWS credentials come from the standard AWS chain (SSO / `aws configure`), never from `.env`; only
`AWS_REGION` is configured in the app.

## Phasing

This layer is **Phase 4** (see the [README roadmap](../README.md#roadmap)), after the backend,
frontend, and rating engine exist. Voice is Phase 5. The MCP tool surface is defined alongside the
backend routes so the agent layer has a stable contract to build on.
