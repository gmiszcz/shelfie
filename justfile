set dotenv-load
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

port := env("PORT", "8000")
host := env("HOST", "0.0.0.0")

# Default: list the available recipes
default:
    @just --list

# Install backend (uv) and frontend (npm) dependencies and create .env
install:
    uv run python -c "import pathlib, shutil; p = pathlib.Path('.env'); p.exists() or shutil.copy('.env.example', p)"
    uv sync --extra dev
    cd frontend && npm install

# Run both services in dev mode (FastAPI + Vite) with hot-reload
[parallel]
dev: dev-backend dev-frontend

# FastAPI dev server (backend)
dev-backend:
    uv run python -m uvicorn app.main:app --reload --host {{host}} --port {{port}}

# Vite dev server (frontend)
dev-frontend:
    npm --prefix frontend run dev

# Ruff lint and format check
lint:
    uv run --no-sync ruff check app tests scripts
    uv run --no-sync ruff format --check app tests scripts

# Auto-fix ruff lint findings and reformat
fix:
    uv run --no-sync ruff check --fix app tests scripts
    uv run --no-sync ruff format app tests scripts

# Run the pytest suite
test:
    uv run --no-sync python -m pytest

# Build the whole library from data/books.json (resets the database first)
build-dbase:
    uv run python -m scripts.dbase build

# Load a random sample of data/books.json into the database (resets it first)
sample count="40":
    uv run python -m scripts.dbase sample --count {{count}}

# Fill structured insights on data/books.json book by book (use --force/--limit/--path via args)
enrich *args:
    uv run python -m scripts.enrich {{args}}

# Build the production frontend bundle
build:
    npm --prefix frontend run build

# Backend gate: ruff, mypy, bandit, pytest
check-backend: lint
    uv run --no-sync python -m mypy app tests scripts
    uv run --no-sync python -m bandit -q -r app scripts
    uv run --no-sync python -m pytest

# Frontend gate: TypeScript, vitest, production build
check-frontend:
    npm --prefix frontend run typecheck
    npm --prefix frontend run test
    npm --prefix frontend run build

# Everything CI runs. Run it at the end of every change
check: check-backend check-frontend

# Build the image on this machine and start it (prod compose + dev build override)
docker:
    DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Run the server in production mode (FastAPI serves the built frontend)
run:
    uv run python -m app
