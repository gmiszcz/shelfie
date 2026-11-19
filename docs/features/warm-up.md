# Warm-up of the mic and the agent

The first mic click and the first agent run were slow. The next ones were fast.
The app now pays that one-time cost in the background when it opens.

## What is slow the first time

The audio goes browser -> our server -> Amazon Transcribe. The browser has no
Transcribe session of its own, so the cold work is on the server.
Measured on a dev PC with `scripts/measure_warmup.py` (no Bedrock call, no stream):

| Step | First time | After warm-up |
|------|-----------|---------------|
| `import boto3` | 0.8-1.1 s | 0 |
| `import amazon_transcribe` | 0.1 s | 0 |
| DNS + TCP + TLS to Transcribe | 0.1-0.2 s | 0 (new handshake per stream stays, about 0.1 s) |
| Credentials (SSO on a dev PC; static keys on Fly) | 0.5-0.7 s locally, 0 on Fly | same |
| First agent (`resolve_session`) | 0.43-0.88 s | 0.24-0.33 s |

Expected saving: about 1-1.5 s on the first mic click and 0.2-0.6 s on the first agent run.
On Fly a stopped machine also needs about 2 s to wake. The warm-up request is the first
call after the app opens, so that wake-up is paid there and not at the mic click.

Not measured: the real stream start to Transcribe (it needs a billed stream) and a phone.

## What the warm-up does

```
app opens (logged in) -> idle + tab visible -> POST /api/warmup (once)
                              |
                              +-> import boto3 + Transcribe SDK, resolve credentials,
                              |   one TLS handshake to the Transcribe host (no request)
                              +-> load the agent config, build one agent and drop it
```

- Free: no Bedrock call, no Transcribe stream, no audio.
- No microphone: the browser never calls `getUserMedia` here.
- Once per app open: no timer, no polling, no keep-alive. A hidden tab waits until it is shown.
- Once per server process: later calls return `{"timings_ms": {}}` at once.
- Needs a login: `401` otherwise. A failing step is logged and skipped.

## Files

- `app/services/warmup.py`: the steps and the once-flag.
- `app/api/routes/warmup.py`: `POST /api/warmup`.
- `frontend/src/warmup.ts`: `warmUpOnce()`, called from `AppShell` in `App.tsx`.
- `scripts/measure_warmup.py`: the timings above.
- Tests: `tests/test_warmup.py`, `frontend/src/warmup.test.ts`.
