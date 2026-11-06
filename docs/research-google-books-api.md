# Google Books API — Research Brief

A factual reference for integrating Google Books API v1 into Shelfie. Endpoints and field names are
from the official documentation.

Primary sources:
- [Using the API](https://developers.google.com/books/docs/v1/using)
- [Getting Started](https://developers.google.com/books/docs/v1/getting_started)
- [Volumes.list reference](https://developers.google.com/books/docs/v1/reference/volumes/list)
- [Volume resource reference](https://developers.google.com/books/docs/v1/reference/volumes)

## 1. Endpoints

### Search (Volumes.list)

```
GET https://www.googleapis.com/books/v1/volumes?q={search terms}
```

`q` is the only required parameter; terms AND-combine. Supports `"exact phrase"` and `-term`.

Query qualifiers (case-sensitive, inside `q`):

| Qualifier | Matches |
|---|---|
| `intitle:` | title |
| `inauthor:` | author |
| `inpublisher:` | publisher |
| `subject:` | category list |
| `isbn:` | ISBN |
| `lccn:` | Library of Congress Control Number |
| `oclc:` | OCLC number |

```
GET .../volumes?q=flowers+inauthor:keyes&key=YOUR_API_KEY
GET .../volumes?q=isbn:9780553804577
```

Useful parameters: `startIndex` (0-based), `maxResults` (default 10, **max 40**), `orderBy`
(`relevance`/`newest`), `printType`, `filter`, `langRestrict`, `projection` (`full`/`lite`).

### Volume lookup by ID (Volumes.get)

```
GET https://www.googleapis.com/books/v1/volumes/{volumeId}
```

The `volumeId` is each item's top-level `id` — the same id used in `books.google.com?id=...` URLs.
**There is no batch/bulk get** — one volume per request.

## 2. JSON response shape

Search response: `{ kind, totalItems, items: [Volume] }`.

Volume resource (key fields, all under `volumeInfo` unless noted):

- `title`, `subtitle`, `authors[]`, `publisher`, `publishedDate`
- `description`, `pageCount`, `categories[]`, `language`
- `averageRating`, `ratingsCount`
- `industryIdentifiers[]` — array of `{ type, identifier }`; `type` is `ISBN_10`, `ISBN_13`,
  `ISSN`, or `OTHER`. **ISBNs are not top-level** — scan this array.
- `imageLinks` — see §3.
- top-level `id` is the `volumeId`.

### imageLinks keys ↔ zoom

| key | zoom | size |
|---|---|---|
| `smallThumbnail` | 5 | smallest |
| `thumbnail` | 1 | small (~128px) |
| `small` | 2 | |
| `medium` | 3 | |
| `large` | 4 | |
| `extraLarge` | 6 | largest |

Usually only `smallThumbnail` and `thumbnail` are present; the larger keys are frequently absent.

## 3. High-resolution cover images

Covers come from the content endpoint:

```
https://books.google.com/books/content?id={volumeId}&printsec=frontcover&img=1&zoom={N}&edge=curl&source=gbs_api
```

- **zoom trick:** lower `zoom` = larger image. Edit `zoom` on the returned thumbnail URL to pull a
  bigger render even when the larger `imageLinks` keys are missing.
- **`&fife=w800` (or `w800-h900`):** community technique to request a pixel size; server returns the
  largest it has up to that. Undocumented — best-effort, verify per volume.
- **`edge=curl`:** adds a page-curl artifact. **Remove it** for a clean flat cover.
- **http → https:** returned URLs may be `http://`; rewrite to `https://` to avoid mixed-content
  blocking in the app.

Community sources (not official): Stack Overflow
[70901084](https://stackoverflow.com/questions/70901084),
[46949548](https://stackoverflow.com/questions/46949548); calibre-web
[#1111](https://github.com/janeczku/calibre-web/issues/1111).

## 4. Rate limits and quotas

- **Without an API key:** commonly ~**1,000 requests/day** (courtesy limit), more aggressively
  throttled.
- **With a key:** quota is tied to your Google Cloud project — read the authoritative, current
  numbers from the Cloud Console (APIs & Services → Books API → Quotas). **Do not hard-code 1,000.**
- **Per-user / per-IP caps** exist on top of the daily total; bursts hit `429`/`403
  rateLimitExceeded`. Back off and retry.
- **Region filtering by IP:** availability and some fields (`accessInfo.country`, preview/buy links,
  viewability) differ by the caller's country.

## 5. Authentication

| Need | API key | OAuth 2.0 |
|---|---|---|
| Public search / volume get | ✅ sufficient | optional |
| Private "My Library" (`/mylibrary/*`), reading positions | ❌ | ✅ required (scope `.../auth/books`) |

Shelfie only searches and fetches metadata/covers, so **an API key is enough** — append
`&key=YOUR_API_KEY`. OAuth is needed only if we ever touch a user's Google bookshelves.

## 6. Gotchas (design implications for Shelfie)

- **Every field is optional** — null-guard `description`, `pageCount`, `categories`, `authors`, etc.
- **ISBNs live in `industryIdentifiers[]`** — match `type === "ISBN_13"` / `"ISBN_10"`.
- **`imageLinks` is sparse** — fall back to the `zoom`/`fife` trick; have a placeholder cover.
- **Thumbnail URLs are unstable** — don't persist as permanent assets; **download and cache covers
  ourselves keyed by `volumeId`** (matches the `cover_cached_path` field in the data model).
- **No bulk endpoint** — batch client-side with throttling + caching to stay under quota.
- **`maxResults` ≤ 40**, `totalItems` is approximate — paginate with `startIndex`.
- **Qualifiers are case-sensitive** (`isbn:` works, `ISBN:` does not).

## Takeaways for implementation

1. Use an API key from config (`GOOGLE_BOOKS_API_KEY`); it is optional but raises quota.
2. Normalize the sparse volume JSON into our `Book` schema at ingest; never trust a field to exist.
3. Cache covers locally (download once per `volumeId`); request a high-res render via `zoom`/`fife`,
   strip `edge=curl`, force `https`.
4. Throttle + retry on `429`/`403`; cache search results to respect the daily quota.
