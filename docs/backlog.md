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
