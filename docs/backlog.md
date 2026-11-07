# Backlog

Ideas the user asked for that are not built yet. Move an item to `docs/features/` when it ships.


## Voice

- Transcribe + AG-UI unification (later).

## Accounts (partially shipped — wave 5)

Accounts, e-mail + password login, admin-only user management and per-user data isolation
shipped in wave 5 — see [features/auth.md](features/auth.md) and [features/cli.md](features/cli.md).
Still not built:

- **Google sign-in.** The schema is ready (the `auth_identities` table maps
  `(provider, subject)` → user), but no OAuth flow is wired yet. Login is e-mail + password only.
- **E-mail delivery of setup/reset links.** Today the admin copies the setup link and sends it
  to the new person by hand; there is no SMTP/transactional-mail integration.
- Sharing books between users.

- Auth: optional 'must change password' flag for accounts given a temporary password from the CLI.

### Auth weak points (owner review 2026-11-07)

Details and suggested fixes: [features/auth.md](features/auth.md#known-weak-points--to-improve).

| # | Point | Status |
|---|---|---|
| 1 | Admin password `admin` is weak | owner changes it in Account |
| 2 | Open registration: anyone who reaches the site can sign up | open (site is tailnet-only for now) |
| 3 | IP throttle trusts a client-set `X-Forwarded-For` | open |
| 4 | No e-mail delivery for password reset | open (see above) |
| 5 | Every login failure shows "Invalid e-mail or password", even a `403` | open |
| 6 | App served by the Vite dev server | open: serve built `dist/` |
| 7 | No automatic backup of `data/users/` | **done**: [features/backup.md](features/backup.md) |
| 8 | Backups on the same disk as the data | open: second copy off-disk |
