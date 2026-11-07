# API reference

Every HTTP endpoint Shelfie exposes, with parameters and response shapes. All
routes are mounted under `/api` (`app/api/router.py`). The app is single-user
today: every request resolves to the seed user via the auth seam
(`app/auth.py`), so no auth header is required yet.

> Generated from the current route code (`app/api/routes/*.py`) and the Pydantic
> schemas (`app/schemas/books.py`, `app/services/stats.py`). The live, always-current
> contract is FastAPI's own OpenAPI docs at `/docs` when the server is running.

## Conventions

- Dates are `YYYY-MM-DD` strings. List fields (`authors`, `shelves`, …) are JSON
  arrays. `signed` is a boolean.
- Errors return `{ "detail": "…" }` (or a list of validation messages for 422).
- `Book` is the full record; `VolumeSearchResult` is not-yet-saved external
  metadata; `BookInput` (create) / `BookPatch` (update) are the write bodies.
  See [data-pipeline.md](data-pipeline.md) for the full field table.

## Health

### `GET /api/health`
Returns `{ "status": "ok" }`.

## Books

### `GET /api/books`
List all books for the user, newest first (`added_at DESC, id DESC`).
**Response:** `Book[]`.

### `POST /api/books`
Add a book (from a search hit, the dataset, or manual entry).
**Body:** `BookInput` (only `title` is required; `metadata_source` defaults to
`manual`, set to `search` by the frontend when adding a hit).
**Response:** `201` + `Book`. If the book sets `stars`, ratings are recomputed and
the returned book includes the fresh `display_score`.
**Errors:** `409` "Book already in library" when `google_volume_id` already exists.

### `GET /api/books/{book_id}`
**Response:** `Book`. **Errors:** `404` "Book not found".

### `PATCH /api/books/{book_id}`
Partial update — only the fields sent are changed.
**Body:** `BookPatch` (any `BookInput` field except `external_id` / `metadata_source`).
**Response:** `Book`. If `stars` is in the patch, ratings are recomputed first.
**Errors:** `404` "Book not found".

### `DELETE /api/books/{book_id}`
**Response:** `204` (no content). **Errors:** `404` "Book not found".

## Search

### `GET /api/search`
Search external catalogues (Google Books, with OpenLibrary fallback). See
[library-and-search.md](library-and-search.md).

| Param | Type | Required | Meaning |
|---|---|---|---|
| `q` | str | yes | Free text or qualifier (`isbn:`, `intitle:`, `inauthor:`), min length 1 |
| `lang` | str | no | ISO-639-1 2-letter language filter |

**Response:** `SearchResponse` = `{ total_items: int, items: VolumeSearchResult[] }`.
**Errors:** `429` (Google rate limit, hint to set `GOOGLE_BOOKS_API_KEY`), `502`
(Google Books request failed).

## Covers

### `POST /api/covers`
Upload a cover image (multipart `file`).
**Validation:** ≤ 5 MB; JPEG/PNG/WebP by magic bytes.
**Response:** `201` + `{ "url": "/api/covers/<name>" }`.
**Errors:** `422` with the reason (empty, too large, unsupported type).

### `GET /api/covers/{name}`
Serve a stored cover. `name` must match `^[0-9a-f]{32}\.(jpg|png|webp)$`.
**Response:** the image file with a long immutable cache header.
**Errors:** `404` for a bad name or a missing file.

## Statistics

### `GET /api/stats`
Reading statistics over finished books. See [statistics.md](statistics.md).

| Param | Type | Default | Meaning |
|---|---|---|---|
| `date_from` | date? | none | Finished on or after |
| `date_to` | date? | none | Finished on or before |
| `group_by` | enum | `month` | `shelf` / `tag` / `month` / `year` |

**Response:** `StatsResponse`:
```
{
  date_from, date_to, group_by,
  summary: { books, pages, average_stars, first_finished, last_finished },
  buckets: [ { key, books, pages } … ],
  books:  [ Book … ]
}
```
**Errors:** `422` when `date_from > date_to`.

## Ratings

Rating-engine endpoints. The comparison log is the source of truth; see
[../rating-engine-algorithm.md](../rating-engine-algorithm.md) for the algorithm.

### `POST /api/ratings/recompute`
Refit every rated book from its stars and the comparison log, then store scores.
**Response:** `{ rated_books: int, comparisons: int }`.

### `GET /api/ratings/pair`
Suggest the next most informative pair to compare.
| Param | Type | Meaning |
|---|---|---|
| `focus` | int? | Prefer pairs involving this book id |

**Response:** `{ left: Book, right: Book }`, or `204` when fewer than two books
are rated.

### `POST /api/ratings/compare`
Record one pairwise comparison, then recompute.
**Body:** `{ left_id: int, right_id: int, winner: "left"|"right"|"tie", session_id?: str }`.
**Response:** `{ left: Book, right: Book }` (the updated pair).
**Errors:** `422` when a book is unknown, unrated, or compared with itself; `404`
if a book cannot be read back.

## Agent (library assistant)

See [chatbot.md](chatbot.md).

### `POST /api/agent/chat`
Stream one agent turn as Server-Sent Events.
**Body:** `{ message: str (1–4000), session_id?: str ([A-Za-z0-9_-], ≤64) }`.
**Response:** `text/event-stream` of the wire protocol:
`session_start → (reasoning | token | tool_start | tool_end)* → session_finish | error`.

### `DELETE /api/agent/sessions/{session_id}`
Drop one in-memory chat session's state. **Response:** `204`.

## Series & waiting list

See [series-tracking.md](series-tracking.md) for the model and the check flow.

### `GET /api/series`
All series derived from the library, with computed progress. **Response:** `SeriesSummary[]`
(`series_key`, `name`, `author`, `aliases`, `owned_volumes[]`, `missing_volumes[]`,
`owned_count`, `read_count`, `unread_owned_count`, `total_known`, `section`, `watch`,
`next_expected`, `next_expected_pl`, `next_expected_en`, `checking`, `last_checked`,
`notes`). Each `NextExpected` is `{ title, date, source_url, confidence, status }` where
`status ∈ {announced, released, unknown}`.

### `GET /api/series/{key}`
One series by canonical key **or any alias** (e.g. `Kroniki Mroku` → King's Dark Tidings).
Poll this while `checking` is true to see the researched release land. **Response:**
`SeriesSummary`, or `404`.

### `PATCH /api/series/{key}`
Edit a series. **Body** (all optional, only the fields present are applied):
`{ watch?, display_name?, aliases?: string[], author?, total_volumes?: int, notes? }`.
Setting `watch=true` schedules the web release-research step as a background task and
returns at once with `checking=true` (poll `GET /api/series/{key}`). To rename across all
member books use `/rename`. **Response:** `SeriesSummary`. **Errors:** `404`.

### `POST /api/series/{key}/books`
Add a library book to the series (sets `book.series` + `book.volume`, mirrored to
`books.json`). A brand-new series name as `{key}` is created. **Body:**
`{ book_id: int, volume?: str }`. **Response:** `SeriesSummary`. **Errors:** `404`.

### `DELETE /api/series/{key}/books/{book_id}`
Remove a book from the series (clears its `series`/`volume`). **Response:** `SeriesSummary`.

### `PATCH /api/series/{key}/books/{book_id}`
Change a member book's volume. **Body:** `{ volume?: str }`. **Response:** `SeriesSummary`.

### `POST /api/series/{key}/rename`
Rename the series on every member book; the old name becomes an alias. **Body:**
`{ name: str }`. **Response:** `SeriesSummary`.

### `POST /api/series/{key}/merge`
Merge another series into this one (its books move here, its names become aliases).
**Body:** `{ other_key: str }`. **Response:** `SeriesSummary`.

### `POST /api/series/{key}/refresh`
Re-run the web release-research step for one series (DuckDuckGo + page fetch, disk-cached,
budget 12; **never Google Books**). Schedules it as a background task and returns at once
with `checking=true`. **Response:** `SeriesSummary`.

### `POST /api/series/check`
Re-run web release research for every watched series. **Response:** `{ checked, updated,
series[], notes }`.

### `GET /api/series/alerts`
Notifications. **Response:** `{ count, in_progress: SeriesAlert[], new_volume: SeriesAlert[] }`.

### `GET /api/series/expected`
Waiting-list entries. **Response:** `ExpectedBook[]`.

### `POST /api/series/expected`
Add a not-yet-owned upcoming book. **Body:** `{ title, author?, series_name?, volume?,
expected_date?, source_url?, ... }`. **Response:** `201 ExpectedBook`.

### `DELETE /api/series/expected/{id}`
Remove a waiting-list entry. **Response:** `204`.

## Books (favourite)

The favourite flag uses the existing book update: `PATCH /api/books/{id}` with
`{ "favourite": true | false }`. See [favourites.md](favourites.md).
