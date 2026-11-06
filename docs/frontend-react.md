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
  for sibling spacing (use flex/grid `gap`).
- Dark/light theme via CSS swap + `MutationObserver`.
- Redux Toolkit for UI/config/library state; typed hooks.

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
