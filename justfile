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

# Find and store real cover images for books missing a cover (updates books.json AND the DB).
# Pass flags via args, e.g. `just fill-covers --dry-run` or `just fill-covers --root E:\WebDev\shelfie`.
fill-covers *args:
    uv run python -m scripts.fill_covers {{args}}

# Map covers for books still without one: Google Books search by title + author, any edition
# of the same work (dry run; add --apply to attach). Stops cleanly on the daily quota (429).
map-google-covers *args:
    uv run python scripts/map_google_covers.py {{args}}

# Repair series/volume/subtitle/description on cycle books (The Way of the Shaman, Dar anomalii).
# Pass flags via args, e.g. `just fix-series --dry-run --scan` or `just fix-series --root E:\WebDev\shelfie`.
fix-series *args:
    uv run python -m scripts.fix_series_titles {{args}}

# Re-check watched series for new/upcoming volumes (Google Books PL+EN + OpenLibrary).
# Schedule this daily via Kiro Crew cron; it only touches series with watch=1.
check-series:
    uv run --no-sync python -m scripts.check_series

# --- Accounts (wave 5). See docs/features/cli.md. ---

# One-time migration to the per-user layout: backup data/, create admin id 1, move the
# legacy library into data/users/1/, verify counts, print a setup link. Refuses to run twice.
users-bootstrap email name origin="http://127.0.0.1:5174":
    uv run --no-sync python -m app.cli users bootstrap --email "{{email}}" --name "{{name}}" --origin "{{origin}}"

# Create a user with an empty library and print a setup link.
users-add email name origin="http://127.0.0.1:5174":
    uv run --no-sync python -m app.cli users add --email "{{email}}" --name "{{name}}" --origin "{{origin}}"

# Print a new setup/reset link for a user (invalidates older unused links).
users-setup-link email origin="http://127.0.0.1:5174":
    uv run --no-sync python -m app.cli users setup-link --email "{{email}}" --origin "{{origin}}"

# List accounts.
users-list:
    uv run --no-sync python -m app.cli users list

# Run the watched-series check for every active user (the daily cron calls this).
series-check-all-users:
    uv run --no-sync python -m app.cli series check --all-users

# Back up auth.sqlite + every data/users/<id>/ into data/backups/<timestamp>/ (keeps 14).
backup keep="14":
    uv run --no-sync python -m app.cli backup --keep {{keep}}

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
