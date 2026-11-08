# Feature documentation

How the Shelfie app actually works today, feature by feature, documented from the
real code. Start here.

## Features

| Doc | Covers |
|---|---|
| [api-reference.md](api-reference.md) | Every endpoint with parameters and response shape. |
| [auth.md](auth.md) | Accounts, e-mail + password login, admin-only user management, per-user data isolation, sessions, CSRF, setup links. |
| [backup.md](backup.md) | `app/backup.py`: online SQLite backup of `auth.sqlite` + every `data/users/<id>/`, retention, the laptop backup cron. |
| [chatbot.md](chatbot.md) | The library agent: its read + write tools, human-in-the-loop confirmation, the SSE wire protocol, and the chat widget. |
| [cli.md](cli.md) | `python -m app.cli`: `users bootstrap/add/setup-link/list`, `series check --all-users`, `backup`, with `just` recipes. |
| [covers.md](covers.md) | Cover storage and serving (`/api/covers/{name}`), content-addressed filenames, long-lived cache headers. |
| [data-cache.md](data-cache.md) | Frontend data cache: TanStack Query + IndexedDB persister, per-user keys, cache clear on logout; backend ETag/304 on `/api/books` and `/api/series`. |
| [data-pipeline.md](data-pipeline.md) | `books.json` as source of truth, `build-dbase` / `sample`, the full book schema and every field's origin, the one-off CSV conversion history. |
| [deploy-fly.md](deploy-fly.md) | Fly.io deployment (app `mybooks`): secrets, env, volume + snapshots, auto stop/start, the laptop crons. |
| [design-system.md](design-system.md) | The "quiet dashboard" visual system: `:root` tokens, the `frontend/src/ui/` components, visual rules, how to build a new tab. |
| [favourites.md](favourites.md) | "Favourites" tab: the `books.favourite` flag, heart toggle on card + detail, shared grid/search/filter. |
| [insights-enrichment.md](insights-enrichment.md) | Per-book AI `insights` (summary, characters, plot, setting, themes, tone) and the enrichment step on Bedrock. |
| [library-and-search.md](library-and-search.md) | Library view, book search, Google Books → OpenLibrary fallback, language filter, API-key / 429 behaviour. |
| [library-ui-wave4.md](library-ui-wave4.md) | The wave-4 library UI: grid/filter/sort refinements and the structured filter facets. |
| [manual-add-and-covers.md](manual-add-and-covers.md) | Manual add form, cover search / upload / URL, cover storage, shared validation. |
| [ranking.md](ranking.md) | The Ranking tab: pairwise "left or right?" comparisons, the pair queue, how `display_score` is shown. |
| [series-tracking.md](series-tracking.md) | "Series" tab data: owned/read/missing volumes, name aliases, watch + daily release check (Google Books PL+EN + OpenLibrary + web research), notifications, waiting list, agent tools. |
| [series-ui.md](series-ui.md) | The Series tab UI: section layout, volume display, the found-volumes and search-language controls, alerts. |
| [statistics.md](statistics.md) | `/api/stats`, grouping, date range, summary cards, charts, table. |
| [ui-agent-registry.md](ui-agent-registry.md) | Universal UI agent: the runtime anchor registry, generic browser tools, date-awareness and structured library filters. |
| [ui-shell-and-settings.md](ui-shell-and-settings.md) | App shell, navigation, book cards/grid/detail, settings. |
| [voice-input.md](voice-input.md) | Hands-free voice input: mic capture, the VAD stop/send state machine, the Transcribe WebSocket, teardown. |

## See also

- [../architecture-overview.md](../architecture-overview.md) — system shape and components.
- [../agent-ag-ui-bedrock.md](../agent-ag-ui-bedrock.md) — both agents, Bedrock, AG-UI tools, voice.
- [../rating-engine-algorithm.md](../rating-engine-algorithm.md) — the rating engine.
- [../backend-fastapi.md](../backend-fastapi.md) — backend layout and config (planning doc).
- [../frontend-react.md](../frontend-react.md) — frontend structure and theming (planning doc).
- The running server's own OpenAPI docs at `/docs`.
