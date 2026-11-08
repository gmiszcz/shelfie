# Shelfie

Personal book collection manager and reading tracker. Multi-user, with per-user libraries. A
FastAPI backend serves a React + PrimeReact frontend, two AI assistants run on AWS Bedrock, voice
input uses AWS Transcribe, and a dynamic relative rating engine refines favourites through pairwise
comparisons.

Live app: [https://mybooks.fly.dev](https://mybooks.fly.dev) (Fly.io app `mybooks`).

## What it does

- Track a private library and reading history (status, dates, stars, shelves, tags, notes).
- Enrich every book with metadata and covers from the Google Books API (OpenLibrary fallback).
- Rank favourites more finely than five stars: when a book earns a perfect 5.0, Shelfie runs a
  short "left or right?" session against other top books and refines a continuous `display_score`.
- Track book series — owned / read / missing volumes, name aliases, and a web release check for the
  next volume (Polish + original editions).
- Chat with a **library agent** that reads and manages the library data, and a **UI agent** that
  drives the on-screen interface; add and search by voice.

## Technology stack

| Layer | Choice |
|---|---|
| Backend | FastAPI, Uvicorn, Pydantic v2 + pydantic-settings, httpx |
| Frontend | React 19, Vite, PrimeReact, TanStack Query (+ IndexedDB persister) |
| Data | SQLite per user (`data/users/<id>/`), shared `auth.sqlite` |
| Book metadata | Google Books API v1, OpenLibrary fallback |
| Rating engine | Pairwise comparison → continuous display score |
| Library agent | AWS Bedrock (Claude Haiku 5.5) via strands-compose, in-process data tools |
| UI agent | Thin Bedrock `converse_stream` runner + browser-side AG-UI frontend-tools |
| Voice | AWS Transcribe (web mic → streaming transcription) |
| Env & tasks | uv + `.venv`, `just` task runner |
| Delivery | Multi-stage, multi-arch Docker image; GitHub Actions → GHCR → Fly.io |

There is **no MCP, A2A or A2UI** — the library agent's tools call `app.services` / SQLite
in-process, and the UI agent's tools run in the browser.

## Architecture at a glance

```
          ┌──────────────────────────────────────────────┐
          │                Frontend (React)               │
          │  PrimeReact UI · TanStack Query cache         │
          │  voice capture → AWS Transcribe (WebSocket)   │
          └───────────────┬──────────────────────────────┘
                          │ REST + SSE + WebSocket
          ┌───────────────▼──────────────────────────────┐
          │                Backend (FastAPI)              │
          │  books/series API · rating engine · auth      │
          │  library agent (SSE) · UI agent runner (SSE)  │
          └───────┬───────────────┬───────────────┬───────┘
                  │               │               │
        ┌─────────▼──┐   ┌────────▼────────┐  ┌───▼─────────┐
        │ Google     │   │ AWS Bedrock      │  │ AWS         │
        │ Books API  │   │ (Haiku 5.5)      │  │ Transcribe  │
        └────────────┘   └──────────────────┘  └─────────────┘
```

Full detail: [`docs/architecture-overview.md`](docs/architecture-overview.md).

## Run it locally

Requires [uv](https://docs.astral.sh/uv/), [just](https://github.com/casey/just), Node 22+, and
(for images) Docker with Buildx.

```bash
just install     # uv sync --extra dev + npm install + create .env
just dev         # FastAPI (:8000, hot-reload) + Vite dev server (:5174) in parallel
just check       # the full gate: ruff, mypy, bandit, pytest, tsc, vitest, build
just docker      # build the multi-arch image locally and run it
```

The backend listens on port **8000**; the Vite dev server on **5174** (it proxies `/api` to the
backend). For a production run, `just build` then `just run` serves the built frontend from FastAPI
on one port. Create the first account with `just users-bootstrap` / `just users-add` (see
[`docs/features/cli.md`](docs/features/cli.md)). AWS credentials for Bedrock/Transcribe go in `.env`
(`AWS_BEARER_TOKEN_BEDROCK`, `TRANSCRIBE_AWS_*`); see `.env.example`.

`just check` is the single gate CI enforces. See [`docs/devops-ci-cd.md`](docs/devops-ci-cd.md) for
the pipeline, including the Fly.io deploy step.

## Documentation

| Doc | Covers |
|---|---|
| [architecture-overview.md](docs/architecture-overview.md) | System shape, components, request/protocol map, the two agents |
| [agent-ag-ui-bedrock.md](docs/agent-ag-ui-bedrock.md) | Both agents, Bedrock, AG-UI frontend tools, Transcribe, "who answers what" |
| [rating-engine-algorithm.md](docs/rating-engine-algorithm.md) | Dynamic relative rating: stars, pairwise comparisons, display score |
| [devops-ci-cd.md](docs/devops-ci-cd.md) | uv/.venv, the `just check` gate, Docker, GitHub Actions → GHCR → Fly |
| [research-google-books-api.md](docs/research-google-books-api.md) | Google Books API reference: endpoints, response shape, cover resolution, quotas |
| [backend-fastapi.md](docs/backend-fastapi.md) | Backend layout, config and data model (planning doc; reconcile with the real `app/`) |
| [frontend-react.md](docs/frontend-react.md) | Frontend structure and theming (planning doc; reconcile with the real `frontend/src/`) |

### Feature documentation

How the app works today, feature by feature, documented from the real code. Full index:
[`docs/features/README.md`](docs/features/README.md).

## License

TBD.
