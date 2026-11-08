import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../services/api';
import {
  queryKeys,
  useExpectedQuery,
  useQueryUserId,
  useSeriesAlertsQuery,
  useSeriesQuery,
} from '../queries';
import type {
  ExpectedBook,
  SeriesAlertsResponse,
  SeriesFilterId,
  SeriesSearchLang,
  SeriesSummary,
} from '../types';

export interface UseSeries {
  series: SeriesSummary[];
  expected: ExpectedBook[];
  alerts: SeriesAlertsResponse | null;
  filter: SeriesFilterId;
  prefsLoaded: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setWatch: (key: string, watch: boolean) => Promise<void>;
  /** Run the release lookup; `searchLang` overrides (and saves) the stored language. */
  refresh: (key: string, searchLang?: SeriesSearchLang) => Promise<void>;
  /** Persist a new per-series search language (PATCH search_lang). */
  setLang: (key: string, lang: SeriesSearchLang) => Promise<void>;
  /** Add a found volume to the library as Want to read. */
  addVolume: (key: string, title: string, volume: number | null) => Promise<void>;
  removeExpected: (id: number) => Promise<void>;
  /** Set the active filter and persist it to the per-user prefs table. */
  setFilter: (filter: SeriesFilterId) => void;
  /** Dismiss alerts (keys, or all). Optimistic with rollback on error. */
  dismissAlerts: (payload: { alert_keys?: string[]; all?: boolean }) => Promise<void>;
}

/**
 * Loads the Series tab data (series summaries, waiting list, alert feed) from the shared,
 * persisted React Query cache, so leaving and returning to the tab is instant and
 * refetch-free while the data is fresh. Mutations write the cache (`setQueryData`) for an
 * instant UI, then invalidate the affected query. Per-user filter prefs and the
 * checking-poll stay as local behaviour; they are not cached data.
 */
export function useSeries(): UseSeries {
  const userId = useQueryUserId();
  const queryClient = useQueryClient();
  const seriesKey = queryKeys.series(userId);
  const alertsKey = queryKeys.seriesAlerts(userId);
  const expectedKey = queryKeys.expected(userId);

  const seriesQuery = useSeriesQuery();
  const expectedQuery = useExpectedQuery();
  const alertsQuery = useSeriesAlertsQuery();

  const series = seriesQuery.data ?? [];
  const expected = expectedQuery.data ?? [];
  const alerts = alertsQuery.data ?? null;

  const [filter, setFilterState] = useState<SeriesFilterId>('all');
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const setSeriesCache = useCallback(
    (updater: (prev: SeriesSummary[]) => SeriesSummary[]) => {
      queryClient.setQueryData<SeriesSummary[]>(seriesKey, (prev) => updater(prev ?? []));
    },
    [queryClient, seriesKey],
  );

  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: seriesKey }),
      queryClient.invalidateQueries({ queryKey: expectedKey }),
      queryClient.invalidateQueries({ queryKey: alertsKey }),
    ]);
  }, [queryClient, seriesKey, expectedKey, alertsKey]);

  // The stored default search language, kept so a filter write never clobbers it.
  const defaultSearchLang = useRef<SeriesSearchLang>('pl');
  const addMode = useRef<'auto' | 'ask'>('auto');

  // Restore the active filter from the per-user preferences table (any device).
  useEffect(() => {
    let cancelled = false;
    void api
      .getSeriesPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setFilterState(prefs.filter);
          defaultSearchLang.current = prefs.default_search_lang ?? 'pl';
          addMode.current = prefs.add_mode ?? 'auto';
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setPrefsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the filter whenever the user changes it (after prefs are first loaded, so the
  // initial restore does not write back the default and clobber a stored value).
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFilter = useCallback((next: SeriesFilterId) => {
    setFilterState(next);
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
    }
    persistTimer.current = setTimeout(() => {
      void api
        .putSeriesPreferences({
          filter: next,
          sort: null,
          default_search_lang: defaultSearchLang.current,
          add_mode: addMode.current,
        })
        .catch(() => undefined);
    }, 250);
  }, []);

  // While any series is being researched (checking=true), poll the list every 3s so the
  // card flips from the spinner to the found PL/EN release without a manual refresh. Stop
  // once nothing is checking, or after 60s (20 polls) as a safety cap.
  const anyChecking = series.some((s) => s.checking);
  // A finished check may have auto-added found volumes as books (add_mode "auto"):
  // when checking flips true -> false, refetch the library so they show in Library too.
  const wasChecking = useRef(false);
  useEffect(() => {
    if (wasChecking.current && !anyChecking) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.books(userId) });
      void queryClient.invalidateQueries({ queryKey: expectedKey });
    }
    wasChecking.current = anyChecking;
  }, [anyChecking, queryClient, userId, expectedKey]);
  useEffect(() => {
    if (!anyChecking) {
      return;
    }
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      void api
        .listSeries()
        .then((fresh) => queryClient.setQueryData(seriesKey, fresh))
        .catch(() => undefined);
      if (polls >= 20) {
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [anyChecking, queryClient, seriesKey]);

  const setWatch = useCallback(
    async (key: string, watch: boolean) => {
      const updated = await api.setSeriesWatch(key, watch);
      setSeriesCache((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
      // Watching a series can add/remove a new-volume alert; refresh the badge feed.
      void queryClient.invalidateQueries({ queryKey: alertsKey });
    },
    [setSeriesCache, queryClient, alertsKey],
  );

  const refresh = useCallback(
    async (key: string, searchLang?: SeriesSearchLang) => {
      const updated = await api.refreshSeries(key, searchLang);
      setSeriesCache((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
    },
    [setSeriesCache],
  );

  const setLang = useCallback(
    async (key: string, lang: SeriesSearchLang) => {
      const updated = await api.updateSeries(key, { search_lang: lang });
      setSeriesCache((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
    },
    [setSeriesCache],
  );

  const addVolume = useCallback(
    async (key: string, title: string, volume: number | null) => {
      const updated = await api.addSeriesVolume(key, title, volume);
      setSeriesCache((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
      // The waiting list may have lost its entry for this book; the library gained a book.
      void queryClient.invalidateQueries({ queryKey: expectedKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.books(userId) });
    },
    [setSeriesCache, queryClient, expectedKey, userId],
  );

  const removeExpected = useCallback(
    async (id: number) => {
      await api.deleteExpected(id);
      queryClient.setQueryData<ExpectedBook[]>(expectedKey, (prev) =>
        (prev ?? []).filter((e) => e.id !== id),
      );
    },
    [queryClient, expectedKey],
  );

  const dismissMutation = useMutation({
    mutationFn: (payload: { alert_keys?: string[]; all?: boolean }) => api.markAlertsSeen(payload),
    onMutate: (payload) => {
      const previous = queryClient.getQueryData<SeriesAlertsResponse>(alertsKey) ?? null;
      queryClient.setQueryData<SeriesAlertsResponse>(alertsKey, (prev) => {
        if (!prev) {
          return prev;
        }
        const matches = (key: string) =>
          payload.all || (payload.alert_keys ?? []).includes(key);
        const mark = (a: SeriesAlertsResponse['new_volume'][number]) =>
          matches(a.alert_key) ? { ...a, seen: true } : a;
        const in_progress = prev.in_progress.map(mark);
        const new_volume = prev.new_volume.map(mark);
        const unseen = [...in_progress, ...new_volume].filter((a) => !a.seen).length;
        return { count: unseen, unseen_count: unseen, in_progress, new_volume };
      });
      return { previous };
    },
    onError: (_err, _payload, context) => {
      // Roll back to the server's last-known value.
      queryClient.setQueryData(alertsKey, context?.previous ?? null);
    },
    onSuccess: (fresh) => {
      queryClient.setQueryData(alertsKey, fresh);
    },
  });

  const dismissAlerts = useCallback(
    async (payload: { alert_keys?: string[]; all?: boolean }) => {
      await dismissMutation.mutateAsync(payload);
    },
    [dismissMutation],
  );

  const error =
    seriesQuery.error?.message ??
    expectedQuery.error?.message ??
    alertsQuery.error?.message ??
    null;

  return {
    series,
    expected,
    alerts,
    filter,
    prefsLoaded,
    loading: seriesQuery.isPending || expectedQuery.isPending || alertsQuery.isPending,
    error,
    reload,
    setWatch,
    refresh,
    setLang,
    addVolume,
    removeExpected,
    setFilter,
    dismissAlerts,
  };
}
