# Architecture Overview

Shelfie is a personal book-collection manager with a reading tracker, a metadata/cover pipeline,
a dynamic relative rating engine, and two AI assistants. It ships as a single container: the
FastAPI backend serves both the REST/SSE/WebSocket API and the built React frontend, and is
deployed on Fly.io (app `mybooks`).

## Design principles

- **Multi-user, per-user data.** Each account has its own SQLite library under
  `data/users/<id>/`; a shared `auth.sqlite` holds accounts and sessions. There is no global
  library — a user's DB is created on first access (`app/api/deps.py`, `app/main.py` lifespan).
- **Store events, derive state.** The rating engine keeps the raw comparison log as the source
  of truth; display scores are recomputable.
- **One deployable unit.** FastAPI serves `frontend/dist` (`app/main.py` `SpaStaticFiles`).
  One image, one port (8000), one healthcheck (`/api/health`).
- **The assistant never gets a privileged side door.** Its data tools call the same
  `app.services` layer the HTTP API uses (or read SQLite directly for reads); its screen
  tools run in the browser against the live UI. There is **no MCP, no A2A and no A2UI** in the
  code.

## Components

| Component | Responsibility |
|---|---|
| **Frontend (React 19 + PrimeReact)** | Library/Series/Favourites/Stats/Ranking tabs, add & cover UI, voice capture, both chat assistants; TanStack Query + IndexedDB data cache |
| **Backend (FastAPI)** | REST + SSE + WebSocket API, Google Books/cover pipeline, rating engine, auth, and both agent runners |
| **Google Books integration** | Search by ISBN/title/author, descriptions, covers (`app/integrations/google_books.py`); OpenLibrary fallback |
| **Rating engine** | Star rating → latent strength; pairwise "left or right?" sessions; continuous `display_score` |
| **Assistant (strands-compose on Bedrock, AG-UI)** | Answers and manages library **data** with server tools (human-in-the-loop for destructive/wide changes) and drives the on-screen UI with browser tools |
| **AWS Transcribe** | Streaming speech-to-text for voice input |
| **Persistence** | SQLite per user (file volume `/app/data`), plus each user's `books.json` and covers |

## Request / protocol map

| Protocol | Where | Purpose |
|---|---|---|
| REST | frontend ↔ backend | CRUD, search, ratings, series, auth |
| SSE | `POST /api/agui` | the assistant: one AG-UI run per request (`RunAgentInput` in, AG-UI events out) |
| WebSocket | `GET /api/transcribe/stream` | voice: PCM up, partial/final transcripts down |
| ETag / 304 | `GET /api/books`, `GET /api/series` | cheap background revalidation of the client cache (`app/api/conditional.py`) |

## The assistant

It runs on **AWS Bedrock** (Claude Haiku 5.5, region `eu-central-1`). Bedrock auth uses the
long-term API key `AWS_BEARER_TOKEN_BEDROCK`, exported from `.env` into the process environment
in `app/main.py` `_export_bedrock_token`; on Fly `AWS_EC2_METADATA_DISABLED=true` keeps boto3 from
probing the EC2 metadata service.

- **Data tools** (`app/agent/config.yaml`, `tools.py`) — run in-process in the strands-compose
  agent: reads hit SQLite directly, writes go through `app.services.books`. Destructive
  (`delete_book`) and wide (`update_book` over three books) changes are two-phase, confirmed by
  the user in chat.
- **Screen tools** (`frontend/src/agui/tools.ts`, `frontend/src/agent-ui/`) — sent by the browser
  with every AG-UI run and executed there against a runtime anchor registry, so they drive any
  current or future tab. `allow_client_tools: true` lets the agent accept them.
- **Endpoint** (`app/api/routes/agui.py`, `app/agent/sessions.py`) — `POST /api/agui`, one
  session per (user, AG-UI `threadId`).

See [agent-ag-ui-bedrock.md](agent-ag-ui-bedrock.md) and [features/chatbot.md](features/chatbot.md)
for the full picture, including a "Who answers what" request-path table.

## Data flow

1. **Add a book.** Enter an ISBN/title (or add by voice/chat) → backend queries Google Books
   (OpenLibrary fallback) → stores normalized metadata + a cached cover reference.
2. **Rate.** 1–5 stars; a 5.0 enqueues a comparison session.
3. **Compare.** The backend picks an informative pair → the UI shows "left or right?" → each
   choice appends to the comparison log → scores refit into `display_score`.
4. **Chat / voice.** A chat request goes to the assistant, which uses data tools on the server
   and screen tools in the browser; voice is transcribed by AWS Transcribe and sent to the same
   assistant.

## See also

- [backend-fastapi.md](backend-fastapi.md) — backend layout and config.
- [frontend-react.md](frontend-react.md) — frontend structure and theming.
- [rating-engine-algorithm.md](rating-engine-algorithm.md) — the rating engine.
- [agent-ag-ui-bedrock.md](agent-ag-ui-bedrock.md) — both agents, Bedrock, Transcribe.
- [devops-ci-cd.md](devops-ci-cd.md) — the `just check` gate, Docker, CI/CD, Fly deploy.
- [features/](features/README.md) — per-feature docs from the real code.
