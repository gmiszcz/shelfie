# Design system — the "quiet dashboard" look

Shelfie's frontend uses one small, consistent visual system: a very light page with a
faint dotted grid, content in large white **panels** with soft 1px borders and generous
radius, nested soft-tinted sub-panels, small muted **monospace section labels**, big bold
KPI numbers with tiny **sparklines**, and soft-tinted status **pills** in one accent colour
per category. Dark mode mirrors the same structure with dark surfaces.

Everything is driven by tokens in `frontend/src/index.css :root` and a handful of generic
components in `frontend/src/ui/`. New tabs should compose those components rather than invent
their own chrome.

## Tokens (`frontend/src/index.css :root`)

All spacing, radius, elevation, type and colour come from CSS variables. Never hardcode a
`rem`/`px` for spacing, and never use `margin` for sibling spacing — use flex/grid `gap`.

### Spacing (single source of truth)

| Variable | Value | Use |
|---|---|---|
| `--small-padding` | 0.25rem | tiny control padding |
| `--default-padding` | 0.5rem | default padding |
| `--big-padding` | 1rem | section padding |
| `--content-padding` | 1.5rem | dialog / content padding |
| `--panel-padding` | 1.75rem | **panel inset** (the generous dashboard feel) |
| `--small-gap` / `--default-gap` / `--big-gap` | 0.5 / 1 / 1.5rem | gaps between items / cards / sections |

### Radius

| Variable | Value | Use |
|---|---|---|
| `--radius-sm` | 0.5rem | small controls, focus rings |
| `--radius-md` | 0.75rem | sub-panels, inputs, dropdown panels |
| `--radius-lg` | 1rem (~16px) | **panels**, cards, dialogs, sidebar |
| `--radius-pill` | 999px | status pills, segmented buttons, nav items |

`--custom-border-radius` (0.5rem) is kept as a legacy alias for older component CSS.

### Elevation

One authored shadow, never a zero-offset halo:

- `--shadow-panel` — resting panels/cards (offset + soft blur).
- `--shadow-pop` — overlays (dialogs, sidebar, chat panel, FAB).

Each panel declares elevation **once** (a 1px border *and* the soft shadow is the intended
ghost-card look here — deliberate, matching the reference, not an accident).

### Typography

- `--font-sans` — UI text (Inter → system sans fallback).
- `--font-mono` — section labels, pills, counts, numeric columns, code
  (JetBrains Mono → `ui-monospace`/Consolas fallback).
- `--label-size` (0.72rem) + `--label-tracking` (0.12em) — the section-label look.

> Fonts are referenced by family name with a robust system fallback; no web font is fetched
> and no font dependency is added, so the look is portable and offline-safe. To upgrade to a
> self-hosted Inter/JetBrains Mono later, add the `@fontsource` packages and an `@import`; the
> variables already point at the right families.

### Accent palette — one hue per category

`green` = good/positive, `orange` = caution, `red` = bad/blocked, `blue` = info/primary,
`violet` = secondary, `grey` = neutral/muted. Each hue has three tokens:
`--accent-<hue>` (solid line/stroke), `--accent-<hue>-soft` (pill background) and
`--accent-<hue>-text` (pill text). All are **retinted for dark** so soft pills stay legible on
dark surfaces.

### Theme surfaces

`--app-bg`, `--app-bg-dot` (dotted grid), `--app-surface` (panel), `--app-surface-2/3`
(sub-panels), `--app-border` / `--app-border-strong`, `--app-text` / `--app-text-muted` /
`--app-text-faint`, `--app-accent` / `--app-accent-soft`, and the single dark feature panel
(`--app-feature-*`). Light is the **default** theme (`App.tsx`); the `data-theme` attribute on
`<html>` swaps the token set and the PrimeReact lara light/dark theme CSS together.

## Components (`frontend/src/ui/`)

All generic and dependency-light, exported from `ui/index.ts`. Import from `../ui` only; never
re-implement one.

| Component | Props (key) | What it is |
|---|---|---|
| `Panel` | `label`, `icon`, `actions`, `tint`, `flush` | the large surface card. `label` renders a monospace `SectionLabel` heading; `tint` = `green`/`blue`/`orange`/`violet` soft sub-panel, or `feature` for the dark callout; `flush` removes padding for edge-to-edge tables. |
| `SectionLabel` | `icon`, `as` | small muted monospace, letter-spaced, uppercased label above a section or stat (e.g. `TODAY · 24H RECAP`). |
| `StatCard` | `label`, `value`, `trend`, `tone`, `sparkColor`, `caption` | a KPI unit: mono label + big bold value + optional inline `Sparkline` from `trend`. Renders only the stat block (no box), so it composes inside a `Panel`/grid without nesting cards. |
| `Sparkline` | `data`, `width`, `height`, `color`, `area` | tiny inline SVG line (+ soft area) for a trend. `color` defaults to the themed accent. |
| `Pill` | `tone`, `dot` | soft-tinted status chip (e.g. `filled`, `skipped`). One `tone` per category; optional leading dot for list rows. |
| `SearchInput` | — | the one search box (icon + clear in reserved padding). |
| `BookCover` | `size` | 2:3 poster box with size presets. |
| `StatusTag` | `status` | reading-status badge (maps to a soft pill via the PrimeReact `Tag` override). |

PrimeReact widgets (Button, SelectButton, Dropdown, Calendar, Dialog, Sidebar, DataTable, Tag,
Chip, Message) are kept but **retinted** by overrides at the end of `index.css` so they match the
system in both themes — e.g. buttons and nav items are pills, `SelectButton`'s selected segment is
a readable soft-accent chip, `Tag` renders as a soft pill, DataTable headers use the mono label
style.

## Visual rules

- Page: `--app-bg` with the `radial-gradient` dotted grid; content in `Panel`s separated by
  `--big-gap`. Generous whitespace; nothing cramped.
- Section = a `Panel` with a `SectionLabel` heading. Stats/KPIs = a grid of `StatCard`s inside a
  `Panel`, sparkline where a sensible series exists.
- Status = a `Pill` (or a PrimeReact `Tag`, which inherits the pill look). Pick the `tone` from
  the category palette and use it consistently.
- Numbers, counts and labels use `--font-mono`; numeric table columns use tabular figures.
- Theme the browser surfaces too: selection, scrollbar and focus ring are themed from the palette
  in `index.css`.

## How to build a new tab

1. Page root: a flex column with `gap: var(--big-gap)`.
2. Wrap each section in a `Panel` with a `label` (and `icon`) — the label is the mono section
   header for free.
3. For KPIs, put `StatCard`s in a `grid` (`repeat(auto-fit, minmax(180px, 1fr))`, `gap:
   var(--big-gap)`) inside a `Panel`. Pass a `trend` array (e.g. per-period buckets) for the
   sparkline and a `sparkColor` from the accent palette.
4. For statuses/labels use `Pill` (or `StatusTag`); never hand-roll a coloured chip.
5. For a table, use a `flush` `Panel` and a PrimeReact `DataTable` (already themed).
6. Keep **all** spacing from the `:root` tokens; keep both themes working (the token set is
   swapped by `data-theme`, so using the tokens is all that is required).

Reference implementation: `frontend/src/pages/Stats.tsx` (Panels + StatCards + Sparklines +
SectionLabels). Series/Favourites tabs can adopt the same components directly.

## Responsive

Breakpoints are documented tokens in `:root` (media queries can't read CSS variables, so the
tokens are the single source of the pixel values the `@media` blocks use — keep them in sync):

| Token | Value | Range |
|---|---|---|
| `--bp-phone` | 640px | phones: single/2-col, **bottom tab bar**, full-screen dialogs/sidebar/chat |
| `--bp-tablet` | 1024px | tablets (641–1024px): denser multi-column that still breathes |
| `--touch-target` | 44px | minimum touch target on phones (nav items, buttons, icon buttons) |

Per-screen behaviour on phones (`<= --bp-phone`):

- **App chrome:** the top nav becomes a **fixed bottom tab bar** (icon over label), fitting 5+
  tabs at 375px, respecting `env(safe-area-inset-bottom)`; brand + theme/settings stay in the top
  bar; page content is padded clear of the bar. The chat launcher is lifted above the bar.
- **Library:** toolbar stacks full width, add buttons share a row, star chips become one tidy
  horizontally-scrolling row (no lone 5-star chip on a second line), grid is 2 columns.
- **Book detail:** full-screen dialog (`100dvh`); cover stacks above the text, centered; fields
  stack; actions become full-width stacked buttons.
- **Add/edit form:** full-screen dialog; the eight tabs scroll horizontally; fields are one column.
- **Settings sidebar:** full width.
- **Statistics:** controls stack full width; KPI cards in a 2×2 grid; chart and table readable; the
  table scrolls horizontally rather than squashing columns.
- **Ranking:** section controls stack full width; compare cards stack (the "vs" divider drops out);
  the table scrolls horizontally.
- **Chat:** full-screen using `100dvh` so iOS Safari's URL bar never clips it.

Tablets (641–1024px) keep the top nav and use a comfortable multi-column grid. The shared
components and PrimeReact overrides are size-agnostic; a new tab built from `Panel` + `StatCard`
etc. inherits all of this for free.

Verified at: 390×844 and 375×667 (phones), 820×1180 and 768×1024 (iPad portrait), 1180×820 and
1024×768 (iPad landscape), plus 1440×900 (desktop), in light and dark.

## See also

- [../frontend-react.md](../frontend-react.md) — frontend structure, theming, shared components.
- [ui-shell-and-settings.md](ui-shell-and-settings.md) — app shell, nav, cards, settings.
- [statistics.md](statistics.md) — the Statistics page behaviour (unchanged by the restyle).
