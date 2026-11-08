# DevOps — Environment, Build & CI/CD

Standardized by the `python-fastapi-docker-boilerplate` skill, modeled on the `home-dashboard`
reference. The chain: **uv/.venv → Justfile gate → multi-stage/multi-arch Docker → GitHub Actions
→ GHCR.**

## Environment: uv + .venv

uv owns the virtualenv and the lockfile.

```bash
uv venv              # create .venv pinned to requires-python (>=3.11)
uv sync --extra dev  # install runtime + dev deps from uv.lock
```

- Runtime deps in `pyproject.toml` `[project].dependencies`; dev tools (pytest, ruff, mypy, bandit)
  in `[project.optional-dependencies].dev`, **version-pinned** so CI and local agree.
- Commit `uv.lock`; CI installs with `uv sync --locked --extra dev` (fails on a stale lock).
- `.venv/` and all tool caches are git-ignored.

## Quality gate: the Justfile

`just check` is the single gate, split so each half runs alone:

| Recipe | Runs |
|---|---|
| `just install` | uv sync + npm install + create `.env` |
| `just dev` | uvicorn `--reload` + Vite dev server, in parallel |
| `just lint` / `just fix` | ruff check + ruff format (`--check` / apply) |
| `just test` | pytest |
| `just check-backend` | **ruff → mypy → bandit → pytest** |
| `just check-frontend` | tsc → vitest → vite build |
| `just check` | `check-backend` + `check-frontend` |
| `just build` | production frontend build |
| `just docker` | build the image locally and start it |

Notes: `set dotenv-load`; Windows uses `set windows-shell := [...]` for PowerShell; recipes call
tools via `uv run --no-sync`.

## Docker: multi-stage, multi-arch

`Dockerfile` has two stages:

1. **web** — `node:22-...-slim` pinned to `$BUILDPLATFORM`: builds the Vite bundle on the native
   builder (not under QEMU — the output is just static files).
2. **runtime** — `python:3.12-slim-...`: installs `requirements.txt`, copies `app/` and the built
   `frontend/dist`, declares an `/app/data` `VOLUME`, a `HEALTHCHECK` on `/api/health`, and
   `CMD ["python", "-m", "app"]`.

Compose:

- `docker-compose.yml` — production: **pulls** `ghcr.io/gmiszcz/shelfie:${APP_TAG:-latest}`, no
  build key, env_file `.env`, named volume, `restart: unless-stopped`, bounded json-file logs.
- `docker-compose.dev.yml` — adds the `build:` key for local builds via `just docker`. Deliberately
  not `docker-compose.override.yml`, so a bare `docker compose up` pulls instead of building.

Multi-arch targets live in CI: default `linux/amd64`; PRs and `main` add `linux/arm64`.

## CI/CD: GitHub Actions → GHCR

`.github/workflows/ci.yml` runs on push to `main`/`dev` and PRs to `main`. Four jobs:

1. **backend** — install uv + just, `uv sync --locked --extra dev`, `just check-backend`.
2. **frontend** — Node 22 + npm cache, `npm ci`, `just check-frontend`.
3. **docker** (`needs: [backend, frontend]`) — QEMU + Buildx, decide platforms/tags by branch,
   `docker/build-push-action`. **Push to GHCR only on push to `main`** (`:latest` + `:<sha>`); PRs
   build without pushing; dev stays amd64-only (no QEMU cost).
4. **deploy** (`needs: [docker]`) — **only on push to `main`**: rolls the image out to Fly.io.

## Deploy: Fly.io

The `deploy` job runs on a merge to `main`, in a `production` environment with a `fly-deploy`
concurrency group so two deploys never overlap. It **reuses** the image the `docker` job just
pushed to GHCR (nothing is rebuilt): `flyctl auth docker`, then `docker buildx imagetools create`
copies `ghcr.io/gmiszcz/shelfie:<sha>` to `registry.fly.io/mybooks:<sha>`, and
`flyctl deploy --app mybooks --image … --ha=false` rolls it out. Auth is `FLY_API_TOKEN`
(a repo secret); the app name `mybooks` and `fly.toml` carry the runtime config. See
[features/deploy-fly.md](features/deploy-fly.md).

Hardening:

- Actions pinned to commit SHAs (not moving tags).
- `persist-credentials: false` on checkout.
- `concurrency` cancels superseded non-main runs.
- `provenance: false` + `sbom: false` for compatibility with older Docker daemons.
- `permissions: packages: write` only on the docker job; GHCR login with `GITHUB_TOKEN`.

## Branching & publish

- Work on `dev`, open PRs into `main`.
- CI runs the full gate on every PR; only a merge to `main` publishes an image.
- Protect `main` (no direct push) — enforced by policy and by convention here.

## Local prerequisites

uv, just, Node 22+, Docker with Buildx. `just install` then `just check` should pass before any
commit.
