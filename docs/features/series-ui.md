# Series release UI (wave 6, frontend)

The frontend half of the wave-6 series-release rework. Backend contract lives in
`brief-wave6.md`; this document covers only the UI. All paths are under `frontend/src`.

## What changed

The old series card watch area showed two raw lines (`PL — … source` / `EN — … source`).
It is replaced by an editor-written, facts-only summary: one status icon + label and a
single factual `headline`, with everything else behind a **Details** toggle. A compact
`PL | EN | Both` segmented control lets the user pick the research language per series,
and a new Settings group sets the default for newly watched series.

## Types (`types.ts`)

- `SeriesSearchLang = 'pl' | 'en' | 'both'`.
- `ReleaseStatus = 'released' | 'announced' | 'in_translation' | 'no_news' | 'unknown'`.
- `ReleaseDetail`, `ReleaseEdition`, `ReleaseSummary` — the structured summary.
- `SeriesSummary` gains `search_lang: SeriesSearchLang` and
  `release_summary: ReleaseSummary | null`.
- `SeriesPreferences` gains `default_search_lang: SeriesSearchLang` (default `'pl'`).

## API (`services/api.ts`)

- `updateSeries(key, { search_lang })` — PATCH `/api/series/{key}` with `{ search_lang }`.
- `refreshSeries(key, searchLang?)` — POST `/api/series/{key}/refresh`; sends
  `{ search_lang }` when a language is passed (one-off override, also saved), else `{}`.
- `getSeriesPreferences` / `putSeriesPreferences` now round-trip `default_search_lang`.

## Status icon mapping (`components/releaseStatus.ts`)

| status | icon | label | tone |
| --- | --- | --- | --- |
| released | `pi pi-check-circle` | Released | green |
| announced | `pi pi-calendar` | Announced | blue |
| in_translation | `pi pi-language` | In translation | violet |
| no_news | `pi pi-minus-circle` | No news | grey |
| unknown | `pi pi-question-circle` | Unknown | grey |

`releaseStatusVisual(status)` resolves any value, defaulting to `unknown`. The
research-in-flight state (`checking`) shows a spinner instead of a status.

## Components

- `ui/LangSegmented.tsx` (+ `.css`) — reusable `PL | EN | Both` segmented control
  (radiogroup, 44px touch targets, one row). Exported from `ui/index.ts`.
- `components/SeriesReleaseWatch.tsx` (+ `.css`) — the card watch area: status icon +
  label + one `headline`; a **Details** toggle reveals next title/volume, expected date,
  per-edition PL/EN rows (status + date + small source-icon link), a factual bullet list
  (each with a source-icon link) and an "Added to library" badge (opens the book when
  `added_book_id` is set). Falls back to **Not checked yet** when `release_summary` is null.
- `components/SeriesCard.tsx` — watch toggle now sits in a row with `LangSegmented`; the
  refresh button passes the current language through; the raw PL/EN block is gone.
- `settings/SeriesSettings.tsx` — the new **Series search** settings sub-screen:
  *Default search language: PL / EN / Both* (default PL), saved via the series
  preferences API. Wired into `settings/SettingsSidebar.tsx` with one import + one menu row.

## Waiting-list rows (`pages/Series.tsx` + `pages/Series.css`)

Clean title (ellipsised, no per-word wrapping), `date` or `no date`, and the source as a
small external-link icon (44px target) instead of the word "source". Phone (390px) keeps
each row to single ellipsised lines with the actions fixed to the right.

## UI-agent anchors

- `series.release.details.<seriesKey>` (button) — open / close / toggle the Details body.
- `settings.series.defaultSearchLang` (select) — read/set the default research language.
Both use the existing `useAgentAnchor` pattern.

## Tests

- `components/releaseStatus` + `SeriesReleaseWatch.test.tsx` — status-icon mapping,
  headline rendering, Details expand, added-book open, `release_summary` null fallback,
  checking spinner.
- `components/SeriesCard.test.tsx` — language control reflects `search_lang`, `onSetLang`
  payload, refresh passes the language, headline vs. "Not checked yet".
- `services/api.series.test.ts` — `updateSeries` PATCH `{ search_lang }`, `refreshSeries`
  POST body (with / without language override).

## Screenshots

Captured with Playwright against a detached Vite on port 5192 using the screenshot-only
mock `vite.series-mock.config.ts` (never imported by `vite build`) and
`scripts/series_shots.py`. Verified at 390x844 and 1280x800: status + headline, segmented
control next to Watch, the Details body with per-edition rows and source icons, the
"Added to library" badge, and tidy waiting-list rows (no per-word wrapping).

## Put a book in a series (2026-11-08)

A book added from Google Books has no `series`, so it never shows on the Series tab and
cannot be watched. `components/SeriesAddBook.tsx` (+ `.css`), rendered on the Series tab
just above the Waiting list, fixes that:

- lists the 5 newest library books **without a series** (a search box finds any other);
- the user picks one, types the series name (existing names are suggested through a
  `<datalist>`; a new name creates the series) and an optional volume;
- **Watch for new volumes** is on by default: after `POST /api/series/{name}/books` it calls
  `setWatch(key, true)`, which starts the web research (Bedrock) for that series;
- then the series list and the book cache are reloaded.

Backend: unchanged (`series_service.add_book_to_series` already accepts a new series name).
Test: `components/SeriesAddBook.test.tsx`.
