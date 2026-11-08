# Deploy on Fly.io

Live app: https://mybooks.fly.dev (Fly app `mybooks`, region `fra`).

## Pipeline

```
push to dev  -> backend + frontend checks (no image push, no deploy)
merge to main -> checks -> docker job: build linux/amd64+arm64, push ghcr.io/gmiszcz/shelfie:<sha>
              -> deploy job: flyctl deploy --image ghcr.io/gmiszcz/shelfie:<sha>  (Fly pulls from public GHCR)
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

## Agent speed on Fly (measured 2026-11-08)

`E:\WebDev\shelfie-wt\bench_agents.py`: one `/api/agui/run` turn (7 tools, small state) and
one library-agent question, time to first byte (TTFB) / total, seconds.

| Where | UI turn warm | Library warm |
|---|---|---|
| laptop | 0.02 / 1.4 | 0.27 / 3.2 |
| Fly 512 MB | 2.05 / 3.4 | 2.16 / 5.0 |
| Fly 2 CPU / 1 GB | 2.05 / 3.5 | 2.16 / 6.5 |
| Fly 2 CPU / 1 GB + `AWS_EC2_METADATA_DISABLED` | 0.05 / 1.6 | 0.15 / 3.2 |
| Fly 512 MB + `AWS_EC2_METADATA_DISABLED` | 0.05 / 1.4 | 0.16 / 3.0 |

Cause: a constant ~2 s before the first byte on every request, independent of CPU/RAM.
boto3 builds a new client per request and, finding no AWS credentials file on Fly, probed the
EC2 metadata service (IMDS) until it timed out. `AWS_EC2_METADATA_DISABLED=true` (in
`fly.toml [env]`) removes it. A bigger machine gives nothing; Fly stays on 512 MB.

## Rotating `FLY_API_TOKEN` (GitHub environment `production`)

Create the token with `fly tokens create deploy -a mybooks -x 8760h`, check it locally (`$env:FLY_API_TOKEN=...; fly status -a mybooks`), and store it **from a file without a trailing newline**: `cmd /c "gh secret set FLY_API_TOKEN --env production -R gmiszcz/shelfie < token.txt"`, then delete the file. Do not pipe the token from PowerShell 5 (`$t | gh secret set ...`): the pipe re-encodes it and adds a newline, and Fly then rejects it ("token validation error", or a 401 from `flyctl auth docker`). Revoke the old token afterwards (`fly tokens list/revoke -a mybooks`).
