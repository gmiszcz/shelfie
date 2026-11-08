# Daily data backup

Added 2026-11-07 (point 7 of the auth weak-points list).

## What runs

| Part | Where |
|---|---|
| Code | `app/backup.py` (`run_backup`) |
| CLI | `uv run python -m app.cli backup [--to DIR] [--keep 14]` |
| Just | `just backup` / `just backup 30` |
| Schedule | Kiro Crew script cron "Shelfie daily data backup" (id `4f2c74ef`), every day 03:15 local, script `~/.kiro/crew/crons/shelfie_backup.py:run` |
| Tests | `tests/test_backup.py` |

## What is copied

```
data/backups/<YYYYMMDD-HHMMSS>/
  auth.sqlite                 # accounts, sessions
  users/<id>/shelfie.sqlite   # each person's library
  users/<id>/books.json
  users/<id>/covers/...
```

- SQLite files go through the SQLite online-backup API, so a copy taken while the server
  writes is consistent. `-wal` / `-shm` files are skipped (folded in by the backup).
- `data/cache/` is skipped: it is not personal and can be rebuilt.
- The run writes into `<stamp>.partial` and renames it only at the end. A crashed run
  leaves a `.partial` folder that is deleted on the next run and never counts as a backup.
- After success only the newest 14 backups are kept.
- `data/` is git-ignored, so backups never reach the repo.

## Restore

1. Stop the backend.
2. Copy the chosen `data/backups/<stamp>/auth.sqlite` to `data/auth.sqlite` and
   `data/backups/<stamp>/users/<id>/` over `data/users/<id>/`.
3. Start the backend.

## Limits

- The backups live on the same disk (`E:`). A disk failure loses both. A second copy
  (another drive, NAS or cloud) is a later step.
- The cron needs the Kiro Crew gateway running at 03:15. A failed run sends an alert.
