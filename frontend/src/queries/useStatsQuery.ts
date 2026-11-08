import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { api } from '../services/api';
import type { GroupBy, StatsResponse } from '../types';
import { queryKeys } from './keys';
import { useQueryUserId } from './useQueryUser';

export interface StatsRange {
  from: string | null;
  to: string | null;
}

/**
 * Reading statistics for a grouping + date range, cached per user AND per
 * (groupBy, from, to) combination. Re-selecting a range already viewed this session is
 * instant from cache; a new range fetches once and is then cached too. `placeholderData`
 * keeps the previous range's chart on screen while the next range loads (no flash to empty).
 */
export function useStatsQuery(groupBy: GroupBy, range: StatsRange): UseQueryResult<StatsResponse, Error> {
  const userId = useQueryUserId();
  return useQuery({
    queryKey: queryKeys.stats(userId, groupBy, range.from, range.to),
    queryFn: () => api.stats(groupBy, range.from, range.to),
    // Show the last range's data while a new range resolves, so the view never blanks.
    placeholderData: (prev) => prev,
  });
}
