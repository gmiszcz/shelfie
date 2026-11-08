import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { get, set, del } from 'idb-keyval';

import { ApiError } from '../services/api';

/**
 * How long a persisted cache survives on disk. After this a restored cache is
 * discarded on startup, so a device that has not opened the app in a month starts
 * clean rather than restoring very stale data.
 */
export const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * How long a query's data is considered fresh. Inside this window a tab switch (or
 * a component remount) reuses the cached data WITHOUT a network call — this is what
 * makes Library → Ranking → Library instant and refetch-free within a session.
 */
export const STALE_TIME = 1000 * 60 * 5; // 5 minutes

/**
 * Cache buster: a new app release changes this, so {@link persistQueryClient} throws
 * away any cache written by an older build (schema/shape may have changed). Derived
 * from the frontend package version, injected by Vite's `define` as a build constant,
 * with a literal fallback so tests and the type-checker have a value.
 */
export const CACHE_BUSTER: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0-dev';

/** The IndexedDB key the whole persisted query cache lives under. */
const IDB_KEY = 'shelfie-query-cache';

/**
 * The async storage persister backed by IndexedDB (via idb-keyval). IndexedDB holds
 * far more than localStorage and keeps the (potentially large) book list off the main
 * thread's synchronous storage.
 */
export const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get(key),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
  key: IDB_KEY,
});

/** Wipe the persisted cache from IndexedDB (used on logout / user switch). */
export async function clearPersistedCache(): Promise<void> {
  try {
    await del(IDB_KEY);
  } catch {
    // Best effort: a missing/unwritable store is fine, the in-memory clear still runs.
  }
}

/** A 401 is handled globally (the auth layer drops to login); never retry it. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Create the one QueryClient for the app. Defaults encode the stale-while-revalidate
 * contract the owner asked for: data stays fresh for {@link STALE_TIME}, so switching
 * tabs inside a session does NOT refetch; but when the data IS stale (e.g. returning a
 * week later), a mount, a window refocus or a reconnect triggers a BACKGROUND refetch
 * while the last cached data keeps rendering (React Query returns the previous data,
 * never undefined, during a background refetch), so there are no spinners when cached
 * data exists.
 *
 * Note on `refetchOnMount`: `true` (the default) means "refetch on mount only when
 * stale", which is exactly the goal — no reload on a fresh tab switch, a quiet refresh
 * when stale. `'always'` would refetch on every mount even while fresh, defeating the
 * "switching tabs must not reload" requirement, so it is deliberately NOT used.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME,
        gcTime: CACHE_MAX_AGE,
        // Refetch when stale (not on every mount): instant on a fresh tab switch,
        // background refresh when the data has aged out.
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: shouldRetry,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
