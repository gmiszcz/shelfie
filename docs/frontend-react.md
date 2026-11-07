# Frontend — React + PrimeReact

Built with the `react-primereact-frontend` skill. React 19 + Vite + PrimeReact + Redux Toolkit.
The production bundle is static files served by the FastAPI backend from `frontend/dist`.

## Layout (intended)

```
frontend/
  package.json · vite.config.ts · tsconfig*.json
  index.html
  src/
    main.tsx              # entry, store + router providers
    App.tsx               # theme swap (dark/light), routes
    index.css             # :root CSS variables (single source of truth for spacing)
    components/
      Layout.tsx          # collapsible sidebar + theme toggle
    pages/
      Library.tsx         # grid of books, covers, filters
      BookDetail.tsx      # metadata, reading status, rating
      Compare.tsx         # "left or right?" pairwise comparison session
      Agent.tsx           # chat + voice, agent-rendered surfaces
    store/                # Redux Toolkit store + slices (ui, config, library)
    hooks/                # useToast, useLocalStorage, useServerStatus
    api/                  # axios client, typed endpoints
```

## Conventions (from the skill)

- **All spacing from `index.css :root` CSS variables** — never hardcoded `rem`/`px`, never `margin`
  for sibling spacing (use flex/grid `gap`). `--hairline-gap` exists only for the optical gap
  between star glyphs.
- Dark/light theme via CSS swap: the PrimeReact theme files are imported locally with Vite
  `?url` (`App.tsx`) and swapped on one `<link id="primereact-theme">`. No CDN. **Light is the
  default theme.** The `data-theme` attribute on `<html>` swaps the app token set (surfaces,
  accents, soft pill tints) in lockstep with the PrimeReact lara light/dark theme.
- Redux Toolkit for UI/config/library state; typed hooks.

## Design system

The UI follows one small "quiet dashboard" visual system — a light dotted-grid page, large
white panels with soft borders and generous radius, monospace section labels, big KPI numbers
with sparklines, and soft-tinted status pills (one accent hue per category). Tokens live in
`index.css :root` (spacing, `--radius-*`, `--shadow-*`, `--font-sans`/`--font-mono`, the accent
palette and theme surfaces). Full reference, including a "how to build a new tab" guide:
[features/design-system.md](features/design-system.md).

## Shared components (`frontend/src/ui/`)

Reusable components live only here and are imported from `../ui`. Never re-implement them.

| Component | Used in | What it owns |
|---|---|---|
| `Panel` | every page section, dialogs' content | large white (or dark `feature`) surface card; optional monospace `label` heading, `actions`, soft `tint` sub-panel, `flush` for tables |
| `SectionLabel` | section/stat headings everywhere | small muted monospace, letter-spaced, uppercase label |
| `StatCard` | Statistics KPIs (and new tabs) | mono label + big bold value + optional inline `Sparkline` from a `trend` series |
| `Sparkline` | `StatCard`, inline trends | tiny inline SVG line + soft area; themed accent or per-instance colour |
| `Pill` | status/label chips, list rows | soft-tinted chip, one `tone` per category, optional leading dot |
| `SearchInput` | Library, Ranking, Statistics table, Add-book search | icon + clear button in reserved padding, never overlapping text |
| `BookCover` | book card, detail dialog, compare pair, ranking and stats tables, search hits | 2:3 poster box, image or centered book icon; size presets `fill`, `detail`, `compare`, `thumb`, `hit` |
| `StatusTag` | book card, detail dialog | reading-status label and colour (renders as a soft pill) |

A new component that a second screen needs moves into `ui/` and is exported from `ui/index.ts`.
PrimeReact widgets are kept but retinted to the system by overrides at the end of `index.css`.

## Key surfaces

- **Library view.** DataView/grid of covers (from Google Books), filter and search (OR/AND),
  reading-status badges.
- **Book detail.** Full metadata, reading status transitions, star rating input.
- **Comparison session.** Two covers side by side, "I preferred this one" / "about the same".
  Triggered when a book is rated 5.0; drives the rating engine. Shows how many comparisons remain.
- **Agent surface (AG-UI / A2UI).** The agent streams output over SSE/WebSocket and can render or
  update PrimeReact components, show its tool calls live, and pause for human-in-the-loop
  confirmation. Voice input is captured in the browser and streamed to AWS Transcribe. See
  [agent-ag-ui-bedrock.md](agent-ag-ui-bedrock.md).

## Streaming

A small client wrapper subscribes to the backend's SSE/WebSocket agent stream and dispatches
AG-UI/A2UI events into Redux, so agent-driven UI changes flow through the same state as user-driven
ones. Reconnect/backoff handled in a `useServerStatus`-style hook.

## Build & gate

`just check-frontend` runs `tsc` typecheck → vitest → `vite build`. The build output
(`frontend/dist`) is what the backend serves and what the Docker `web` stage produces. See
[devops-ci-cd.md](devops-ci-cd.md).
