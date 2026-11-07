# Backlog

Ideas the user asked for that are not built yet. Move an item to `docs/features/` when it ships.

## Series tracking ("Series" tab)

- Detect series the user has started but not finished: owned volumes, read volumes, missing
  volumes (known from Google Books / OpenLibrary / web), and show "N of M read, K missing".
- Notify the user when a series is still in progress (unread or not-owned volumes exist).
- **Watch toggle per series** ("Watch for new volumes"). Only watched series are checked, so the
  agent never scans the whole library. A scheduled job searches the web for the next volume's
  release date and stores it (expected title, date, source URL, last checked).
- Tab layout: "In progress" (started, unfinished), "Watched / upcoming" (watched series with the
  next expected release), "Complete".

## Favourites tab

- A "Favourite" flag on a book (toggle in the card and the detail view).
- A "Favourites" tab listing favourite books, with the shared search and filters.

## Voice

- Transcribe + AG-UI unification (later).

## Multi-user

- Multi-user, authorization, user and admin panels.
