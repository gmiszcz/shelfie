# Library UI — layout, cards and spacing (wave 4)

This note covers the wave-4 refinement of the library surface: the toolbar layout,
the book-card hierarchy, subtitle handling, and the app-wide spacing pass. All
spacing comes from the `:root` variables in `frontend/src/index.css`
(`--small-padding` … `--big-gap`); no hardcoded `rem`/`px` spacing is used, and
siblings are spaced with flex/grid `gap`, never child margins.

## Library toolbar — three independent rows

`frontend/src/pages/Library.tsx` renders the toolbar as a vertical flex stack
(`.library-toolbar`) with three decoupled rows, each separated by `--default-gap`:

1. `.library-toolbar-actions` — the book count only. Adding a book moved out of the
   Library (2026-11-08): see the round **+** button in [ui-shell-and-settings.md](ui-shell-and-settings.md#add-book-button-everywhere).
2. `.library-toolbar-search` — the search box on **its own full-width row**, using
   the shared `SearchInput` from `frontend/src/ui`. It is fully independent of the
   star filter.
3. `.library-toolbar-filter` — the `StarFilter` chips (`Any`, 1–5 stars).

The search input and the star filter no longer share a row, so they can never
overlap. The old inline search markup and the `.library-search*` styles were
removed in favour of the shared component.

## Book cards — hierarchy

`frontend/src/components/BookCard.tsx` groups card content into clear blocks with
consistent gaps and a footer pinned to the bottom (so cards in a row keep equal
effective heights via the grid's `stretch`):

- **Heading block** (`.card-heading`): the book `title` (prominent, bold) and, for
  a series volume, the **subtitle** rendered just below it in the accent colour —
  the subtitle is the volume's real title (see below).
- **Meta block** (`.card-meta`): author/year (muted, smaller), the series line with
  a bookmark icon and volume, and the page count — all smaller and muted.
- **Shelves** (`.card-shelves`): compact, aligned tags.
- **Footer** (`.card-footer`): status badge and score/stars, pinned to the bottom.

Every field remains driven by `settings.cardFields`, so each can be toggled from
the settings sidebar.

## Subtitle (series volume title)

Many series volumes carry their real title in `book.subtitle` (e.g. title
`Droga Szamana`, subtitle `Gambit Kartosa. Etap drugi`). The subtitle is now shown:

- **On the card** — as an accent-coloured line directly under the title
  (`.card-subtitle`), gated by a new **Subtitle** card field (`settings.cardFields.subtitle`,
  **default on**).
- **In the detail dialog** (`frontend/src/components/BookDetailDialog.tsx`) — as a
  proper prominent `.detail-subtitle` line above the byline, instead of the former
  grey italic highlighted line.

The new `subtitle` card field was added to `frontend/src/settings/settingsTypes.ts`
(`CardField`, `CARD_FIELDS`, `CARD_FIELD_LABELS`); it defaults on because
`DEFAULT_SETTINGS.cardFields` turns every field on, and `mergeSettings` defaults
newly introduced fields to on for existing stored settings.

## App-wide spacing pass

`frontend/src/index.css` now pads every panel from `:root`:

- **App bar** — unchanged structure, already `:root`-based.
- **Settings sidebar** — content wrapped in a padded `.settings-body` flex column;
  section spacing comes from `gap`, not child margins.
- **Book detail dialog** — label/value fields use a flex row with a gap; the action
  row (`.detail-actions`) is separated from the content above it; the quote block is
  a subtle surface callout rather than a thick coloured left border.
- **Form dialog, cover picker, search dialog** — the search dialog toolbar
  (`.search-dialog-bar`) uses the shared `SearchInput`; PrimeReact Dialog and Sidebar
  header/content/footer padding is set from `--content-padding`.

## Verification

- `BookCard.test.tsx` — subtitle shown by default, hidden when the field is off,
  absent when the book has no subtitle, and settings-driven author/year/series.
- `BookDetailDialog.test.tsx` — unchanged section-visibility behaviour still passes.
- Impeccable detector reports no findings on the changed files.
