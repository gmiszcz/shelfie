# Frontend data cache (stale-while-revalidate)

The app's data (books, series, stats) is held in a persistent, per-user client cache so
the UI feels instant:

- **Switching tabs does not reload.** Library → Ranking → Library (or Favourites, Stats)
  reuses the cached data with no network call while it is fresh.
- **Cold start shows the last data immediately.** Coming back after a week, the previously
  seen data renders at once from IndexedDB, then refreshes silently in the background
  (stale-while-revalidate). No spinners or skeletons when cached data exists.

It is built on [TanStack React Query](https://tanstack.com/query) with its IndexedDB
persister. The backend adds HTTP-level validators so a background refresh of unchanged data
costs almost nothing.

## Client: one persisted QueryClient

`frontend/src/queries/queryClient.ts` creates the single `QueryClient` and the IndexedDB
persister (via `idb-keyval`). `frontend/src/main.tsx` wraps the app in
`PersistQueryClientProvider`.

Defaults (`createQueryClient`):

| Option | Value | Why |
|---|---|---|
| `staleTime` | 5 min | Within this window a tab switch / remount reuses the cache with **no** refetch. |
| `gcTime` | 30 days | Cache entries live long enough to be persisted and restored. |
| `refetchOnMount` / `refetchOnWindowFocus` / `refetchOnReconnect` | `true` | When data **is** stale, a mount/focus/reconnect refetches in the **background** while the cached data keeps rendering. (`true` means "only when stale" — deliberately not `'always'`, which would reload even fresh data and defeat the no-reload-on-tab-switch goal.) |

Persistence (`PersistQueryClientProvider`):

| Option | Value | Why |
|---|---|---|
| `persister` | async IndexedDB (idb-keyval) | Holds the (large) book list off synchronous `localStorage`. |
| `maxAge` | 30 days | A cache older than this is discarded on restore. |
| `buster` | app version | `__APP_VERSION__` (injected by Vite from `frontend/package.json` `version`). A new release changes it, so an older build's cache — whose shape may differ — is dropped. |

## Per-user isolation

Every query key is scoped by the logged-in user id (`frontend/src/queries/keys.ts`,
e.g. `['user', <id>, 'books']`), so one person's cache can never be read for another.

On top of that, `AuthProvider` wipes the cache (in-memory **and** the persisted IndexedDB
copy, via `clearPersistedCache`) in two cases:

- **Logout** — so the next person on the device starts clean.
- **User change** — when the logged-in id changes to a different person, the previous
  user's persisted data is dropped before the new one's can render.

## Query hooks

One hook per data type in `frontend/src/queries/`:

| Hook | Endpoint | Notes |
|---|---|---|
| `useBooksQuery` | `GET /api/books` | The library; single source of truth for books. |
| `useSeriesQuery` | `GET /api/series` | Series summaries. |
| `useExpectedQuery` | `GET /api/series/expected` | Waiting list. |
| `useSeriesAlertsQuery` | `GET /api/series/alerts` | Alert feed. |
| `useStatsQuery(groupBy, range)` | `GET /api/stats` | Keyed by `(groupBy, from, to)`; `placeholderData` keeps the previous range's chart while a new range loads. |
| `useFavourites` | — | Derived from `useBooksQuery` (books with `favourite`), so Favourites shares the Library cache and needs no extra request. |

Existing consumers keep their public shape so components and tests changed minimally:

- `hooks/useLibrary.ts` and `hooks/useSeries.ts` now read the cache and expose the same
  return type as before.
- `pages/Ranking.tsx` and `pages/Stats.tsx` read `useBooksQuery` / `useStatsQuery`.
- `pages/Favourites.tsx` reads `useFavourites`.

Comparison pairs on the Ranking page stay on the live `usePairQueue` prefetch queue: they
change on every comparison, so they are not a cacheable snapshot.

## Mutations

Mutations update the affected query optimistically with `setQueryData` (instant UI) and
then invalidate it so the authoritative server copy reconciles in the background:

- Add / edit / delete book, rating, favourite → the `books` query.
- Watch, search-lang, refresh, add found volume → the `series` query; add-volume also
  invalidates `expected` and `books`.
- Dismiss alerts → optimistic flip on the `series alerts` query with rollback on error.

Writes that happen on the SERVER, not through a frontend mutation (fixed 2026-11-08: a book
the agent added showed in Series but not in Library until the 5-minute stale time ran out):

- Every library-agent chat run and every librarian call from the UI agent (`ask_librarian`,
  `librarian_add`) ends with `invalidateQueries(['user', id])` in `chat/ChatProvider.tsx`
  (`refreshUserData`): books, series, waiting list, alerts and stats refetch (unchanged
  lists answer 304).
- `useSeries`: when a series check finishes (`checking` true → false), the `books` and
  `expected` queries are invalidated, because the check may auto-add found volumes as books.

## Backend: ETag / 304 and cover caching

`app/api/conditional.py` adds a strong `ETag` (SHA-256 of the exact JSON body) to
`GET /api/books` and `GET /api/series`. A request whose `If-None-Match` matches gets a
bodyless `304 Not Modified` (with `Cache-Control: private, no-cache`). Because the browser
handles conditional revalidation transparently, the background refetch of unchanged data
sends no body — the client keeps the data it already has. The ETag is derived from the
response itself, so it is correct per user and needs no separate invalidation.

Cover responses (`GET /api/covers/{name}`) send
`Cache-Control: private, max-age=31536000, immutable`: a cover's content-addressed filename
never changes, so the browser can hold it for a year; `private` because it is served from
the current user's folder and must never be cached by a shared proxy.

## Tests

- Frontend: `frontend/src/queries/dataCache.test.tsx` (no refetch on tab switch when fresh;
  cached data renders before the network; cache clear forces a refetch; mutations update the
  list immediately). Component/hook tests wrap renders in `queries/testUtils.tsx`'s
  `QueryWrapper`.
- Backend: `tests/test_caching.py` (cover headers; ETag present; `If-None-Match` → 304;
  ETag changes when the data changes) for both `/api/books` and `/api/series`.

## Verified

With a detached backend (port 8034) and Vite (5194) against a temp copy of the data and a
Playwright session logged in as the real user: Library → Ranking → Library produced **0**
`/api/books` refetches while the data was fresh, and after a reload the book grid rendered
from the persisted IndexedDB cache **with `/api/books` network-blocked** (proving the cache
restore, not the network, populated it).
