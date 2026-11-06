# Architecture Overview

Shelfie is a personal book-collection manager with a reading tracker, a metadata/cover pipeline, a
dynamic relative rating engine, and an AI agent layer. It ships as a single container: the FastAPI
backend serves both the API and the built React frontend.

## Design principles

- **Single-user now, multi-tenant-ready.** Every data row and query path is written so a
  `user_id` / tenant seam can be switched on later without a rewrite. Auth starts as a no-op
  single user but with a JWT-shaped boundary already in place.
- **Store events, derive state.** The rating engine keeps the raw comparison log as the source of
  truth; all scores are recomputable. The same philosophy applies to reading history.
- **One deployable unit.** FastAPI serves `frontend/dist`. One image, one port, one healthcheck.
- **The agent is a client of the same API.** Agents act through MCP tools that wrap the backend's
  own endpoints — no privileged side door.

## Components

| Component | Responsibility |
|---|---|
| **Frontend (React + PrimeReact)** | Library UI, reading status, rating and comparison UI, voice capture, agent-driven surfaces (AG-UI/A2UI) |
| **Backend (FastAPI)** | REST + SSE/WebSocket API, book metadata integration, rating engine, auth, MCP tool host, A2A endpoints |
| **Google Books integration** | Search by ISBN/title/author, fetch descriptions and cover images |
| **Rating engine** | Star rating → latent strength; pairwise comparison sessions; continuous display score |
| **Agent layer (Strands Compose on Bedrock)** | Natural-language and voice interaction, tool use, human-in-the-loop |
| **AWS Transcribe** | Streaming speech-to-text for voice control |
| **Persistence** | SQLite (file volume) to start; model portable to Postgres |

## Data flow

1. **Add a book.** User enters an ISBN/title or speaks it → backend queries Google Books → stores
   normalized metadata + cached cover reference.
2. **Rate.** User gives 1–5 stars. A 5.0 enqueues a comparison session.
3. **Compare.** Backend picks the most informative pair (active learning) → frontend shows
   "left or right?" → each choice is appended to the comparison log → scores refit.
4. **Agent.** A chat/voice request → Strands Compose agent on Bedrock → calls MCP tools (which call
   the backend API) → streams UI updates and tool-call previews to the frontend via AG-UI/A2UI,
   pausing for human-in-the-loop confirmation where needed.

## Protocol map

| Protocol | Where | Purpose |
|---|---|---|
| REST | frontend ↔ backend | CRUD, search, ratings |
| SSE / WebSocket | backend → frontend | streaming agent output, live UI updates |
| **MCP** | backend | exposes library operations as agent tools |
| **A2A** | backend | agent-to-agent coordination in the background |
| **AG-UI / A2UI** | frontend | agent renders/controls UI components, shows tool calls, requests confirmation |

## Phasing

See the roadmap in the [README](../README.md#roadmap). Phase 0 (this one) delivers tooling,
research, and these docs. Nothing in the data model or API is implemented yet; the documents below
describe the intended design so implementation phases have a target.

- [backend-fastapi.md](backend-fastapi.md)
- [frontend-react.md](frontend-react.md)
- [rating-engine-algorithm.md](rating-engine-algorithm.md)
- [agent-ag-ui-bedrock.md](agent-ag-ui-bedrock.md)
- [devops-ci-cd.md](devops-ci-cd.md)
- [research-google-books-api.md](research-google-books-api.md)
