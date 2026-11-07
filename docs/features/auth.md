# Accounts, login and per-user data

Status: design agreed with the owner on 2026-11-07. This file is the contract the backend
and frontend work follow.

## Decisions (from the owner)

| Topic | Decision |
|---|---|
| Login | E-mail + password now. Google sign-in may be added later (schema is ready for it). |
| Data isolation | One separate data folder per person: own SQLite, own `books.json`, own covers. |
| Who creates accounts | Only the admin. There is no public sign-up. |
| Session length | 30 days, sliding. |
| First admin | Patryk Batóg, `patryk.batog@gmail.com`. He owns all existing data. |
| Next user | Added later by the admin; starts with an empty library. |

## Storage layout

```
data/
  auth.sqlite                 # accounts, sessions, setup tokens, login attempts (shared)
  cache/                      # Google Books + web caches: not personal, stay shared
  users/<user_id>/
    shelfie.sqlite            # the person's library (same schema as before)
    books.json                # the person's dataset mirror
    covers/                   # the person's uploaded covers
```

- Inside each per-user SQLite the existing `user_id` columns keep the constant
  `SINGLE_USER_ID = 1`. Isolation comes from the separate file, so no row is rewritten.
- `data/shelfie.sqlite`, `data/books.json` and `data/covers/` are the legacy single-user
  paths. The bootstrap command moves them into `data/users/1/` (after a backup) and the
  server never reads the legacy paths again.

### `auth.sqlite` schema

| Table | Columns |
|---|---|
| `users` | `id` PK, `email` UNIQUE (stored lower-case, trimmed), `display_name`, `password_hash` (argon2id, NULL until set), `is_admin` 0/1, `disabled` 0/1, `created_at`, `password_changed_at` |
| `auth_identities` | `id` PK, `user_id` FK, `provider` (e.g. `google`), `subject`, `created_at`, UNIQUE(`provider`,`subject`). Empty now; reserved for Google sign-in. |
| `sessions` | `id` PK, `token_hash` UNIQUE (SHA-256 of the cookie token), `user_id` FK, `created_at`, `expires_at`, `last_seen_at`, `user_agent`, `ip` |
| `setup_tokens` | `id` PK, `token_hash` UNIQUE, `user_id` FK, `purpose` (`setup` or `reset`), `created_at`, `expires_at`, `used_at` |
| `login_attempts` | `id` PK, `email`, `ip`, `at`, `success` 0/1 |

## Security rules

- Passwords: argon2id (`argon2-cffi`, library defaults or stronger). Minimum 10 characters.
  Unknown e-mail still runs one dummy verify so timing does not reveal accounts.
- Session cookie `shelfie_session`: 32 random bytes (urlsafe), only the SHA-256 hash is
  stored. `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the request came over HTTPS
  (scheme or `X-Forwarded-Proto`, setting `cookie_secure = auto|true|false`).
  Lifetime 30 days; when less than 15 days remain the expiry is pushed back to 30 days.
- Changing a password revokes every other session of that user. Disabling a user revokes
  all of their sessions. Logout deletes the current session.
- Setup/reset links: 32 random bytes, hash stored, valid 24 h, single use. Creating a new
  link invalidates older unused links of that user.
- Login throttle: more than 5 failed attempts for one e-mail or one IP within 15 minutes
  returns `429` with `Retry-After`. Generic error text: "Invalid e-mail or password".
- CSRF: `SameSite=Lax` plus every state-changing request (`POST/PUT/PATCH/DELETE`) must
  carry `X-Shelfie-Client: web` (the frontend adds it to every request) or it gets `403`.
  If an `Origin` header is present it must match the request host.
- Every `/api/*` route needs a valid session except `GET /api/health`,
  `POST /api/auth/login`, `POST /api/auth/setup` and `GET /api/auth/setup/{token}`.
  WebSockets (voice/transcribe, chat streams) check the same cookie during the handshake
  and close with code `4401` when it is missing.
- Uploaded covers are served through an authenticated route that reads only the
  caller's `covers/` folder. No path from the client is joined without validation.
- Secrets never go to logs: no passwords, tokens or token hashes.

## Request scoping

- A dependency `current_user` resolves the cookie to an `AuthUser`
  (`id, email, display_name, is_admin`). `require_admin` builds on it.
- `UserData` holds the user's paths (`database_file`, `dataset_file`, `covers_dir`).
  The dependency sets a `contextvars.ContextVar` so code that has no request object
  (agent tools in `app/agent/tools.py`, `app/services/books_json.py`, research) reads the
  right files. Background tasks capture the `UserData` explicitly when scheduled and set
  the context var inside the task; they never fall back to a global path.
- The chat engine keys its sessions by `(user_id, session_id)`. One user can never load
  another user's chat session.
- If no user context is set, data access raises an error. There is no silent default.

## HTTP API

| Method | Path | Who | Body / result |
|---|---|---|---|
| POST | `/api/auth/login` | public | `{email, password}` -> `200 {user}` + cookie; `401`; `429` |
| POST | `/api/auth/logout` | user | `204`, cookie cleared |
| GET | `/api/auth/me` | user | `{id, email, display_name, is_admin}`; `401` when not logged in |
| POST | `/api/auth/password` | user | `{current_password, new_password}` -> `204`, other sessions revoked |
| GET | `/api/auth/setup/{token}` | public | `{email, display_name, purpose}` or `410` when expired/used |
| POST | `/api/auth/setup` | public | `{token, password}` -> `200 {user}` + cookie (logs the person in) |
| GET | `/api/admin/users` | admin | list of users with `has_password`, `disabled`, `created_at`, book count |
| POST | `/api/admin/users` | admin | `{email, display_name}` -> `201 {user, setup_url, expires_at}`; creates an empty data folder |
| PATCH | `/api/admin/users/{id}` | admin | `{display_name?, disabled?, is_admin?}`; the last active admin cannot be disabled or demoted |
| POST | `/api/admin/users/{id}/setup-link` | admin | `{setup_url, expires_at}` (password reset link) |

`setup_url` is built from the request's own origin: `<origin>/setup?token=<token>`.

## Command line

`uv run python -m app.cli ...` (and matching `just` recipes):

| Command | What it does |
|---|---|
| `users bootstrap --email E --name N` | Once. Backs up `data/`, creates admin user 1, moves the legacy library into `data/users/1/`, checks row counts match, prints a setup link. Refuses to run twice. |
| `users add --email E --name N` | Creates a user with an empty library and prints a setup link. |
| `users setup-link --email E` | Prints a new setup/reset link. |
| `users list` | Lists accounts. |
| `series check --all-users` | Runs the watched-series check for every active user. The daily cron calls this instead of HTTP. |

Scripts under `scripts/` that read the library (`map_google_covers.py`, `_dataio.py`
users) take `--user <email or id>` and resolve the per-user paths.

## Frontend

- `AuthProvider` loads `GET /api/auth/me` once; while loading it shows a neutral splash.
- Not logged in: `LoginPage` (e-mail, password, "Log in"). Errors inline, 429 shows the wait.
- `/setup?token=...`: `SetupPasswordPage` shows who the link is for, password + repeat,
  strength hint (min 10), then logs in and opens the library.
- Any `401` from the API sends the app back to the login page and keeps the target route.
- User menu (top bar on desktop, More/Account on phones): name, "Change password",
  "Users" (admin only), "Log out".
- `Users` page (admin): table of accounts; "Add person" dialog (name, e-mail) that shows
  the setup link with a Copy button; per-row "New link" and "Disable/Enable".
- All fetches send `credentials: 'same-origin'` and `X-Shelfie-Client: web`.
- UI rules: shared components from `frontend/src/ui/`, `:root` spacing tokens, gap-based
  layout, responsive at 375/390 and iPad portrait/landscape.
- UI-agent anchors: none for auth screens (the agent must not log anyone in or out or
  manage accounts).

## Not in scope now

- Google sign-in (table `auth_identities` is ready).
- Sharing books between users.
- E-mail delivery of setup links (the admin copies the link).

## Implementation notes (backend)

The API shape above is implemented exactly. A few details the contract left open were
resolved as follows; none change the request/response shape:

- **Modules.** The shared auth database lives in `app/authdb.py` (schema + data access) and
  `app/services/auth_service.py` (login, sessions, setup links, provisioning, last-admin
  protection). Password hashing and tokens are in `app/security.py` (argon2id via
  `argon2-cffi`; only SHA-256 token hashes are stored). Per-user path resolution is
  `app/userdata.py`: a `UserData` dataclass plus a `contextvars.ContextVar`. The request sets
  the context in the `current_user` dependency (`app/api/deps.py`); background tasks and the
  CLI capture a `UserData` and set the context explicitly; a missing context raises
  `NoUserContext` (no silent global default). CSRF lives in `app/api/middleware.py`.
- **E-mail validation.** Bodies use a dependency-free regex validator rather than Pydantic's
  `EmailStr`, to avoid adding the `email-validator` runtime dependency for one check. E-mails
  are still stored lower-cased and trimmed.
- **Status codes not pinned by the contract.** Wrong current password on
  `POST /api/auth/password` → `400`; a weak new password → `422`; admin creating a duplicate
  e-mail → `409`; last-admin protection → `409`.
- **Disabled users.** A disabled account fails login with the same generic
  `401` message (no account-existence leak) and its live sessions are revoked when it is
  disabled.
- **Covers** are served through `GET /api/covers/{name}`, which now requires a session and
  reads only the current user's `covers/` folder (name-validated, path-contained).
- **Chat sessions** are keyed `(user_id, session_id)` in the engine; the client-facing
  `session_id` is unchanged.
- **Bootstrap** (`app.cli users bootstrap`) backs up `data/` to `data/backup-auth-<ts>/`,
  creates admin id 1, moves the legacy library into `data/users/1/`, asserts the row counts of
  `books` / `comparisons` / `series_info` / `expected_books` are unchanged, prints a setup link
  (origin default `http://127.0.0.1:5174`), and refuses to run twice. See
  [cli.md](cli.md).
