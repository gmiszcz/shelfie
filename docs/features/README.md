# Feature documentation

How the Shelfie app actually works today, feature by feature, documented from the
real code (not the earlier planning docs). Start here.

## Features

| Doc | Covers |
|---|---|
| [data-pipeline.md](data-pipeline.md) | `books.json` as source of truth, `build-dbase` / `sample`, the full book schema and every field's origin, the one-off CSV conversion history |
| [library-and-search.md](library-and-search.md) | Library view, book search, Google Books → OpenLibrary fallback, language filter, API-key / 429 behaviour |
| [manual-add-and-covers.md](manual-add-and-covers.md) | Manual add form, cover search / upload / URL, cover storage, shared validation |
| [statistics.md](statistics.md) | `/api/stats`, grouping, date range, summary cards, charts, table |
| [design-system.md](design-system.md) | The "quiet dashboard" visual system: `:root` tokens, the `frontend/src/ui/` components (Panel, SectionLabel, StatCard, Sparkline, Pill, …), visual rules, and how to build a new tab |
| [series-tracking.md](series-tracking.md) | "Series" tab: owned/read/missing volumes, name aliases, watch + daily checker (Google Books PL+EN + OpenLibrary, quota-safe), notifications, waiting list, agent tools |
| [favourites.md](favourites.md) | "Favourites" tab: `books.favourite` flag, heart toggle on card + detail, shared grid/search/filter |
| [chatbot.md](chatbot.md) | The current read-only library assistant: tools, SSE wire protocol, chat widget |
| [api-reference.md](api-reference.md) | Every endpoint with parameters and response shape |

## Related feature docs (other workstreams)

These are owned by other feature workstreams and may land after this set:

| Doc | Covers |
|---|---|
| [rating-engine-algorithm.md](../rating-engine-algorithm.md) | Dynamic relative rating: stars, pairwise comparisons, `display_score`, star-filter bands |
| [insights-enrichment.md](insights-enrichment.md) | Per-book AI `insights` (summary, characters, plot, setting, themes, tone) and enrichment |
| [ui-shell-and-settings.md](ui-shell-and-settings.md) | App shell, navigation, book cards/grid/detail, settings |
| [agent-ag-ui-bedrock.md](../agent-ag-ui-bedrock.md) | AG-UI streaming, the agent → UI event bus, voice input |
| [ui-agent-registry.md](ui-agent-registry.md) | Universal UI agent: the runtime anchor registry, generic tools, date-awareness and structured library filters |

## See also

- [../architecture-overview.md](../architecture-overview.md) — system shape and components.
- [../backend-fastapi.md](../backend-fastapi.md) — backend layout and config.
- [../frontend-react.md](../frontend-react.md) — frontend structure and theming.
- The running server's own OpenAPI docs at `/docs`.
