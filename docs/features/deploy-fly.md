# Deploy on Fly.io

Live app: https://mybooks.fly.dev (Fly app `mybooks`, region `fra`).

## Pipeline

```
push to dev  -> backend + frontend checks (no image push, no deploy)
merge to main -> checks -> docker job: build linux/amd64+arm64, push ghcr.io/gmiszcz/shelfie:<sha>
              -> deploy job: copy that image to registry.fly.io/mybooks:<sha>
                             -> flyctl deploy --image registry.fly.io/mybooks:<sha>
```

- Fly never builds the app and never polls GitHub. Only a merge to `main` deploys.
- The `deploy` job uses the GitHub environment `production` and its secret
  `FLY_API_TOKEN` (a deploy token scoped to the `mybooks` app, valid 1 year; create a new
  one with `fly tokens create deploy -a mybooks` and `gh secret set FLY_API_TOKEN --env production`).
- A deploy starts the machine for the health check; it stops again after idle.

## Machine and cost

| Setting | Value (`fly.toml`) |
|---|---|
| size | `shared-cpu-1x`, 512 MB |
| idle | `auto_stop_machines = "stop"`, `min_machines_running = 0` (cold start ~2 s) |
| data | volume `shelfie_data` 1 GB at `/app/data`; Fly takes daily snapshots, kept 5 days |
| env | `COOKIE_SECURE=true`, `REGISTRATION_ENABLED=false`, `GOOGLE_BOOKS_MAX_CALLS=20` |

Pay as you go: running time ($3.69 per 30 days if always on) + volume $0.15/GB + stopped
rootfs. For a few hours a month that is about 1-3 zł.

## Secrets

Set with `fly secrets set` (never in the repo): `AWS_BEARER_TOKEN_BEDROCK` (Bedrock
long-term key), `TRANSCRIBE_AWS_ACCESS_KEY_ID` / `TRANSCRIBE_AWS_SECRET_ACCESS_KEY`
(Transcribe-only IAM user), `GOOGLE_BOOKS_API_KEY`.

## Data upload (one-off)

The first deploy started with an empty volume. The local `data/` was copied as a
consistent backup (`python -m app.cli backup`) into `fly-data.tgz`, uploaded with
`fly ssh sftp shell -a mybooks` (`put E:/.../fly-data.tgz /tmp/fly-data.tgz`; use forward
slashes), and unpacked into `/app/data`. No Google Books call is made by this.

## Scheduled work

There is no timer on Fly. The watched-series check runs when someone opens the app and
the last check is older than 24 h (see series-tracking.md). The laptop Kiro Crew jobs
(series 09:30, backup 03:15) act on the laptop copy only.

## Notes

- `flyctl` auto-update broke the local install (renamed `flyctl.exe`, missing
  `wintun.dll`); auto-update is now disabled (`fly settings autoupdate disable`,
  `FLY_NO_UPDATE_CHECK=1`).
- SPA routes (`/setup?token=...`) fall back to `index.html` (`SpaStaticFiles` in `app/main.py`).
- The login throttle uses `Fly-Client-IP`, then the last `X-Forwarded-For` hop.
