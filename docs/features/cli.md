# Command line (`python -m app.cli`)

Account management and the all-users series check live in `app/cli.py`. Run with
`uv run python -m app.cli ...` (matching `just` recipes below). All of this is the
server-side counterpart of the admin UI and the daily series cron.

## Commands

| Command | What it does |
|---|---|
| `users bootstrap --email E --name N [--origin URL]` | **Once.** Migrates the legacy single-user layout to the per-user layout. Backs up `data/` to `data/backup-auth-<timestamp>/`, creates admin user id 1, moves the legacy library (`data/shelfie.sqlite`, `data/books.json`, `data/covers/`) into `data/users/1/`, asserts the row counts of `books` / `comparisons` / `series_info` / `expected_books` are unchanged, and prints a single-use setup link (valid 24 h). **Refuses to run twice** (it stops if admin user 1 already exists). `--origin` defaults to `http://127.0.0.1:5174`. |
| `users add --email E --name N [--origin URL]` | Creates a user with an empty library folder and prints a setup link. |
| `users setup-link --email E [--origin URL]` | Prints a new setup (no password yet) or reset (has a password) link, invalidating the user's older unused links. |
| `users list` | Lists accounts: id, e-mail, admin, disabled, whether a password is set, book count. |
| `series check --all-users` | Runs the watched-series web release-research for every active user's library. This is what the daily cron calls instead of hitting HTTP. Never calls Google Books. |

## Setup links

A setup/reset link is `<origin>/setup?token=<token>`. The raw token is shown once; only its
SHA-256 hash is stored. It is valid 24 h and single use; creating a new link for a user
invalidates their older unused ones. The admin copies the link to the new person (there is no
e-mail delivery yet — see `docs/backlog.md`).

## `just` recipes

```
just users-bootstrap email="patryk@example.com" name="Patryk Batóg"
just users-add email="a@example.com" name="A. Person"
just users-setup-link email="a@example.com"
just users-list
just series-check-all-users
```

## Notes

- The CLI and the server share `app/config.py`: the data root is `DATA_DIR` (default `data`),
  the auth database is `AUTH_DB_PATH` (default `data/auth.sqlite`).
- `bootstrap` is the only command that reads the legacy single-user paths; after it runs the
  server only ever reads `data/users/<id>/`.
- See [auth.md](auth.md) for the full accounts/sessions/security contract.
