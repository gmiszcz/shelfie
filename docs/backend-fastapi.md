# Backend — FastAPI

The backend is a FastAPI app built with the `fastapi-backend` skill and standardized by the
`python-fastapi-docker-boilerplate` skill. It serves the REST + streaming API and, in production,
the built React frontend.

## Layout (intended)

```
app/
  __main__.py        # python -m app → uvicorn entrypoint
  main.py            # FastAPI app, lifespan, CORS, router include, static mount
  config.py          # pydantic-settings Settings (env + .env), get_settings()
  auth.py            # JWT seam — single-user now, token-ready
  api/
    router.py        # aggregates routers
    deps.py          # shared dependencies (current_user, db session)
    routes/
      books.py       # CRUD + search (Google Books), covers
      ratings.py     # star ratings, comparison sessions
      agent.py       # SSE/WebSocket agent stream, MCP/A2A endpoints
  schemas/           # Pydantic request/response models
  repositories/      # data access (SQLite now, Postgres-portable)
  services/
    google_books.py  # Google Books client (httpx)
    rating.py        # Bradley-Terry / Elo engine
tests/               # pytest + TestClient
```

## Configuration

`pydantic-settings` reads environment variables and `.env`. Fields match env var names; no secrets
in code. Mirrors the reference `Settings` pattern (typed fields, validators, `@lru_cache`
`get_settings()`). See `.env.example` for the full list. Key fields:

- `HOST`, `PORT`, `DB_PATH`, `LOG_LEVEL`
- `GOOGLE_BOOKS_API_KEY` (optional; raises quota)
- `JWT_SECRET`, `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES`
- `AWS_REGION` (Bedrock/Transcribe; credentials come from the standard AWS chain, not `.env`)

## Data model (intended)

SQLite to start; written to port cleanly to Postgres. Every user-owned table carries a `user_id`
column from day one (set to a constant single-user id now).

```
User
  id · email · display_name · created_at
  (single-user seed row now; SSO/JWT subject maps here later)

Book
  id · user_id
  google_volume_id            # Google Books volume id (nullable for manual entries)
  title · subtitle · authors (json) · publisher · published_date
  description · page_count · categories (json) · language
  isbn_10 · isbn_13
  cover_url · cover_cached_path
  added_at · updated_at

ReadingEntry
  id · user_id · book_id
  status                      # want | reading | finished | abandoned
  started_at · finished_at
  current_page
  notes

Rating
  id · user_id · book_id
  stars_raw                   # original 1-5 (anchor, never overwritten)
  latent_strength             # beta_i / Elo R_i (from the rating engine)
  uncertainty                 # sigma / RD (nullable)
  display_score               # derived 1-5 decimal
  updated_at

Comparison                    # ground-truth event log — kept forever
  id · user_id · session_id
  book_left_id · book_right_id
  winner                      # left | right | tie
  created_at
```

The rating-related fields are detailed in
[rating-engine-algorithm.md](rating-engine-algorithm.md).

## Google Books integration

A thin `services/google_books.py` client over `httpx`. Search uses the `q` qualifiers
(`isbn:`, `intitle:`, `inauthor:`), volume lookup uses `volumes/{id}`, covers use the content
endpoint with the `zoom`/`fife` resolution trick. All fields are treated as optional (null-guarded)
and ISBNs are read from the `industryIdentifiers[]` array. Full reference:
[research-google-books-api.md](research-google-books-api.md).

## Auth: single-user → multi-tenant + SSO/JWT

- **Now:** `auth.py` exposes a `current_user` dependency that returns the single seed user. No login.
- **Seam:** every route already depends on `current_user` and every query filters by `user_id`, so
  nothing in the route layer assumes a single tenant.
- **Later:** flip `current_user` to validate a JWT (`JWT_SECRET`/`JWT_ALGORITHM`), map the token
  subject to a `User` row, and front it with an SSO provider (OIDC). No route signatures change.

## Testing

`pytest` + FastAPI `TestClient`. Google Books and AWS calls are mocked. The gate (`just
check-backend`) runs ruff → mypy → bandit → pytest; see [devops-ci-cd.md](devops-ci-cd.md).
