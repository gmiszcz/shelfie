import type { GroupBy } from '../types';

/**
 * Query-key factory. EVERY key is scoped by the logged-in user id so one person's
 * cache can never be read for another (defence in depth beyond the logout wipe):
 * a different user id produces disjoint keys. Pass the id from `useAuth().user?.id`.
 *
 * Keys are arrays (React Query's structural matching): `queryKeys.books(7)` is a child
 * of `queryKeys.user(7)`, so `invalidateQueries({ queryKey: queryKeys.user(7) })` would
 * invalidate every query for that user at once.
 */
export const queryKeys = {
  user: (userId: number | string) => ['user', userId] as const,

  books: (userId: number | string) => ['user', userId, 'books'] as const,

  series: (userId: number | string) => ['user', userId, 'series'] as const,

  seriesAlerts: (userId: number | string) => ['user', userId, 'series', 'alerts'] as const,

  expected: (userId: number | string) => ['user', userId, 'series', 'expected'] as const,

  stats: (userId: number | string, groupBy: GroupBy, from: string | null, to: string | null) =>
    ['user', userId, 'stats', groupBy, from ?? null, to ?? null] as const,

  /** The ranking comparison pairs for a category/focus combination. */
  rankingPairs: (
    userId: number | string,
    group: string | null,
    focus: number | null,
  ) => ['user', userId, 'ranking', 'pairs', group ?? null, focus ?? null] as const,
} as const;
