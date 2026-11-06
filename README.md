# Shelfie

Personal book collection manager and reading tracker. Single-user today, structured for
multi-tenant + SSO/JWT later. FastAPI backend, React + PrimeReact frontend, an agent layer on
AWS Bedrock, and a dynamic relative rating engine that refines favorites through pairwise
comparisons.

> **Status: preparation phase.** No application code yet. This repository currently holds the
> standardized tooling (uv, Justfile, Docker, CI/CD), the research briefs, and the architecture
> documentation under [`docs/`](docs/). Implementation starts in a later phase.

---

## Vision

Track a private library and reading history, enrich every book with metadata and covers from the
Google Books API, and rank favorites more finely than five stars allow: when a book earns a
perfect 5.0, Shelfie runs a short "left or right?" session against other top books and refines a
continuous latent score (so 4.9 and 5.0 can be told apart). An agent layer lets you search, add,
and curate the library by voice and chat, with the UI streamed and partly rendered by the agent.

## Technology stack

| Layer | Choice |
|---|---|
| Backend | FastAPI, Uvicorn, Pydantic v2 + pydantic-settings, httpx |
| Frontend | React 19, Vite, PrimeReact, Redux Toolkit |
| Data | SQLite to start (file-backed), model structured for a later move to Postgres |
| Book metadata | Google Books API v1 (search by ISBN/title/author, descriptions, covers) |
| Rating engine | Pairwise comparison — Bradley-Terry (batch MLE) with Elo as the MVP path |
| Agent layer | AWS Bedrock via Strands Compose; A2A (agent-to-agent), MCP (backend tools), AG-UI / A2UI (frontend) |
| Voice | AWS Transcribe (web mic → streaming transcription) |
| Env & tasks | uv + `.venv`, `just` task runner |
| Delivery | Multi-stage, multi-arch Docker image; GitHub Actions → GHCR |

## Architecture at a glance

```
          ┌────────────────────────────────────────────┐
          │                Frontend (React)             │
          │  PrimeReact UI · AG-UI/A2UI streaming (SSE/WS)│
          │  voice capture → AWS Transcribe              │
          └───────────────┬──────────────────────────────┘
                          │ REST + SSE/WebSocket
          ┌───────────────▼──────────────────────────────┐
          │                Backend (FastAPI)              │
          │  books API · rating engine · auth (JWT-ready) │
          │  MCP tools  ·  A2A  ·  Strands Compose agents  │
          └───────┬───────────────┬───────────────┬───────┘
                  │               │               │
        ┌─────────▼──┐   ┌────────▼────────┐  ┌───▼─────────┐
        │ Google     │   │ AWS Bedrock      │  │ AWS         │
        │ Books API  │   │ (Strands Compose)│  │ Transcribe  │
        └────────────┘   └──────────────────┘  └─────────────┘
```

Full detail: [`docs/architecture-overview.md`](docs/architecture-overview.md).

## Documentation

| Doc | Covers |
|---|---|
| [architecture-overview.md](docs/architecture-overview.md) | System shape, components, data flow, phasing |
| [backend-fastapi.md](docs/backend-fastapi.md) | FastAPI layout, config, data model, single-user → multi-tenant, JWT/SSO |
| [frontend-react.md](docs/frontend-react.md) | React + PrimeReact structure, state, theming, agent-driven UI surface |
| [rating-engine-algorithm.md](docs/rating-engine-algorithm.md) | Dynamic relative rating: Elo, Bradley-Terry, TrueSkill/Glicko, pair selection |
| [agent-ag-ui-bedrock.md](docs/agent-ag-ui-bedrock.md) | Strands Compose, AG-UI/A2UI, A2A, MCP, Bedrock, Transcribe, human-in-the-loop |
| [devops-ci-cd.md](docs/devops-ci-cd.md) | uv/.venv, Justfile gate, multi-stage/multi-arch Docker, GitHub Actions → GHCR |
| [research-google-books-api.md](docs/research-google-books-api.md) | Google Books API reference: endpoints, response shape, cover resolution, quotas |

## Development

Requires [uv](https://docs.astral.sh/uv/), [just](https://github.com/casey/just), Node 22+, and
(for images) Docker with Buildx.

```bash
just install     # uv sync --extra dev + npm install + create .env
just dev         # FastAPI (hot-reload) + Vite dev server in parallel
just check       # the full gate: ruff, mypy, bandit, pytest, tsc, vitest, build
just docker      # build the multi-arch image locally and run it
```

`just check` is the single gate CI enforces. See
[`docs/devops-ci-cd.md`](docs/devops-ci-cd.md) for the pipeline.

## Roadmap

- **Phase 0 — Preparation (current).** Repo tooling standardized on the shared boilerplate skill;
  research done; architecture documented. No app code.
- **Phase 1 — Backend core.** FastAPI skeleton, config, SQLite data model, book CRUD, Google Books
  integration (search, metadata, covers), single-user auth seam (JWT-ready).
- **Phase 2 — Frontend core.** React + PrimeReact shell, library views, add-by-ISBN/search,
  reading status, star rating.
- **Phase 3 — Rating engine.** Comparison event log, Bradley-Terry fit, pairwise "left or right?"
  sessions on a 5.0, continuous display scores, calibration sessions.
- **Phase 4 — Agent layer.** Strands Compose on Bedrock, MCP tools over the backend, A2A, AG-UI/A2UI
  streaming to the frontend, human-in-the-loop.
- **Phase 5 — Voice.** AWS Transcribe web control.
- **Phase 6 — Multi-tenant + SSO.** Flip the prepared seams on: per-user data isolation, SSO/JWT.

## License

TBD.
