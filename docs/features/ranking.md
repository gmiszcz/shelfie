# Ranking page

The pairwise-comparison ranking workflow and the Ranking tab's layout.

> Documents the current code: `frontend/src/pages/Ranking.tsx`,
> `frontend/src/pages/Ranking.css`, `frontend/src/components/ComparePair.tsx`,
> `frontend/src/components/HalfStarRating.tsx`, `frontend/src/ranking.ts`,
> `frontend/src/ui/SearchInput.tsx`.

## What the page does

The Ranking tab turns a shelf of star-rated books into a refined order. A star
rating fixes a book's **band** (a 5★ book lives in `4.6–5.0`, a 4.5★ book in
`4.1–4.5`, and so on); pairwise comparisons then nudge books within their band
without ever crossing it, so the star order is always preserved. Comparisons are
always between two books in the **same category**.

The page has three stacked regions, separated by a single `--big-gap` on the
`.rank-page` flex column (no child margins):

1. **Toolbar** (`.rank-toolbar`) — a flex row, centre-aligned, with
   `gap: var(--default-gap)`: the **Recalculate scores** button and the
   `N rated books` count. `POST /api/ratings/recompute` recalculates every
   display score from the stored comparisons.
2. **Info box** (`.rank-infobox`) — a padded, 1px-bordered note explaining the
   band model. The info icon carries the accent; there is no coloured side border.
3. **Refine the ranking** (`.rank-section`) — the category + focus dropdowns and
   the "N comparisons this visit" counter in an aligned `.rank-section-head`, over
   a padded `.rank-compare-panel` holding the `ComparePair` cards.
4. **Ranking table** (`.rank-section`) — the search box, shelf filter and
   "Only 5★" toggle in `.rank-section-head`, over a padded `.rank-table-panel`
   wrapping the PrimeReact `DataTable`.

## Layout and spacing

All padding, gaps and radii come from the `:root` variables in
`frontend/src/index.css` (`--small-padding` … `--big-gap`, `--card-padding`,
`--custom-border-radius`). Siblings are spaced with `display: flex|grid` + `gap`,
never with margins on children. Every container (info box, compare panel, table
panel, compare cards) carries panel padding so content never touches an edge.
The compare cards stack vertically below 640px (`ComparePair.css`).

## Search

The ranking search uses the shared **`SearchInput`** component
(`frontend/src/ui/SearchInput.tsx`, `import { SearchInput } from '../ui'`) — the
same box Library and Statistics use. Its search icon and clear button sit in
reserved padding on each side of the input, so they never overlap the typed text.
The page only constrains its width (`.rank-search { min-width: 240px }`); it does
not restyle the component. `filterBySearch` (in `ranking.ts`) matches the query
against title, authors and series, case-insensitively.

### UI bus

The page listens on the `shelfie:ui` window event for
`{ action: 'ranking', query }` and writes `query` into the search box, then
acknowledges on `shelfie:ui:ack` with
`{ action: 'ranking', ok: true, info }` — `searching for "<query>"` for a
non-empty query, or `cleared the ranking search` for an empty one. This lets the
chatbot drive the ranking search. The listener is bound once and reads live state
through refs.

## Tests

- `frontend/src/ranking.test.ts` — ranking/scoring logic (`rankBooks`,
  `formatScore`, `bandOf`, `confidenceOf`, `groupOptions`, `filterBySearch`, …).
- `frontend/src/pages/Ranking.test.tsx` — the page renders the shared
  `SearchInput` (and no longer the old `.rank-search` span), and the UI-bus
  `ranking` action fills/clears the box and acks correctly.
- `frontend/src/ui/SearchInput.test.tsx` — the shared component itself.

## Prefetch queue (no wait between comparisons)

The ranking page keeps three pairs ready (`frontend/src/hooks/usePairQueue.ts`). A choice shows the next queued pair at once; the comparison is saved with `POST /api/ratings/compare` in the background, then the queue is refilled with `GET /api/ratings/pairs?count=N&skip=a-b,c-d` (one model fit, distinct pairs, skipping pairs still queued and, when possible, pairs already compared). The covers of queued pairs are preloaded. The ranking table refreshes once, 1.5 s after the last choice. Changing category or focus drops the queue and loads a fresh one.

