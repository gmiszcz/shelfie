import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { api } from '../services/api';
import type { ExpectedBook, SeriesAlertsResponse, SeriesSummary } from '../types';
import { queryKeys } from './keys';
import { useQueryUserId } from './useQueryUser';

/** The series summaries for the Series tab, cached per user. */
export function useSeriesQuery(): UseQueryResult<SeriesSummary[], Error> {
  const userId = useQueryUserId();
  return useQuery({
    queryKey: queryKeys.series(userId),
    queryFn: () => api.listSeries(),
  });
}

/** The series-tab "waiting list" (expected books), cached per user. */
export function useExpectedQuery(): UseQueryResult<ExpectedBook[], Error> {
  const userId = useQueryUserId();
  return useQuery({
    queryKey: queryKeys.expected(userId),
    queryFn: () => api.listExpected(),
  });
}

/** The new-volume / in-progress alert feed, cached per user. */
export function useSeriesAlertsQuery(): UseQueryResult<SeriesAlertsResponse, Error> {
  const userId = useQueryUserId();
  return useQuery({
    queryKey: queryKeys.seriesAlerts(userId),
    queryFn: () => api.seriesAlerts(),
  });
}
