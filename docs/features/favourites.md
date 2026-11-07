# Favourites ("Favourites" tab)

A simple per-book **favourite** flag with a heart toggle, and a **Favourites** tab that
lists the flagged books in the same grid as the Library. Wave 5.

## Data model (additive)

A single boolean column `books.favourite` (default `false`), added by the idempotent
startup migration in `app/db.py` — no table drop, no `build-dbase`. It flows through the
normal book schema (`BookFields` / `Book` / `BookUpdate`) and the repository's JSON/bool
coercion, so it is read and written like `signed`.

The dataset import/export path maps it automatically: `books.json` records validate through
`BookCreate` (which now has `favourite`), so a `favourite` field in the dataset is loaded,
and a missing one defaults to `false`. `build-dbase` stays compatible and is not run.

## Toggling

The favourite is changed through the **existing** book update path — `PATCH /api/books/{id}`
with `{ "favourite": true | false }`. No new endpoint.

The UI toggle is the shared `FavouriteToggle` component (`frontend/src/ui/`), a real
`<button>` with an accessible name and `aria-pressed`, shown in two places:

- **On a book card** — a heart pinned to the top-right over the cover (`variant="overlay"`).
  It stops click/keyboard propagation, so toggling the favourite never opens the card's
  detail dialog.
- **In the book detail dialog** — an inline heart next to the byline.

Both are wired to the same handler (`PATCH favourite`) in the Library, Series and
Favourites pages.

## The Favourites tab

`frontend/src/pages/Favourites.tsx` reuses `useLibrary`, filters to `book.favourite`, and
renders the shared `BookGrid` with:

- the shared `SearchInput` (filters favourites by title/author/series),
- the shared `StarFilter` (same whole-star bands as the Library),
- the heart on each card (un-favouriting removes the book from the list),
- empty states for "no favourites yet" and "no favourites match the filter".

Nav order: **Library · Series · Favourites · Statistics · Ranking**.

## Agent tools

The library assistant can read and set favourites: `list_favourites` and
`set_favourite(book, on)` (resolves a book by id or a title/search phrase). See
[series-tracking.md](series-tracking.md#agent-tools).

## Tests

- `tests/test_series_api.py::test_favourite_toggle_via_patch` — PATCH toggles the flag.
- `tests/test_series_api.py::test_favourite_column_migrates_on_a_copy_of_the_live_db` —
  the column is added by the migration on an older DB.
- `frontend/src/ui/FavouriteToggle.test.tsx` — accessible pressed state, toggles value,
  does not bubble the click to a parent card.
