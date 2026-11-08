import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../services/api';
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

/** Loads the Series tab data: series summaries, the waiting list and the alert feed. */
export function useSeries(): UseSeries {
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [expected, setExpected] = useState<ExpectedBook[]>([]);
  const [alerts, setAlerts] = useState<SeriesAlertsResponse | null>(null);
  const [filter, setFilterState] = useState<SeriesFilterId>('all');
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, e, a] = await Promise.all([
        api.listSeries(),
        api.listExpected(),
        api.seriesAlerts(),
      ]);
      setSeries(s);
      setExpected(e);
      setAlerts(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load series');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
  const setFilter = useCallback(
    (next: SeriesFilterId) => {
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
    },
    [],
  );

  // While any series is being researched (checking=true), poll the list every 3s so the
  // card flips from the spinner to the found PL/EN release without a manual refresh. Stop
  // once nothing is checking, or after 60s (20 polls) as a safety cap.
  const anyChecking = series.some((s) => s.checking);
  useEffect(() => {
    if (!anyChecking) {
      return;
    }
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      void api
        .listSeries()
        .then((fresh) => setSeries(fresh))
        .catch(() => undefined);
      if (polls >= 20) {
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [anyChecking]);

  const setWatch = useCallback(async (key: string, watch: boolean) => {
    const updated = await api.setSeriesWatch(key, watch);
    setSeries((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
    // Watching a series can add/remove a new-volume alert; refresh the badge feed.
    void api.seriesAlerts().then(setAlerts).catch(() => undefined);
  }, []);

  const refresh = useCallback(async (key: string, searchLang?: SeriesSearchLang) => {
    const updated = await api.refreshSeries(key, searchLang);
    setSeries((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
  }, []);

  const setLang = useCallback(async (key: string, lang: SeriesSearchLang) => {
    const updated = await api.updateSeries(key, { search_lang: lang });
    setSeries((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
  }, []);

  const addVolume = useCallback(async (key: string, title: string, volume: number | null) => {
    const updated = await api.addSeriesVolume(key, title, volume);
    setSeries((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
    // The waiting list may have lost its entry for this book.
    setExpected(await api.listExpected());
  }, []);

  const removeExpected = useCallback(async (id: number) => {
    await api.deleteExpected(id);
    setExpected((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const dismissAlerts = useCallback(
    async (payload: { alert_keys?: string[]; all?: boolean }) => {
      const previous = alerts;
      // Optimistic: flip the targeted alerts to seen and drop the unseen count now.
      setAlerts((prev) => {
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
      try {
        const fresh = await api.markAlertsSeen(payload);
        setAlerts(fresh);
      } catch (err) {
        setAlerts(previous); // rollback
        throw err;
      }
    },
    [alerts],
  );

  return {
    series,
    expected,
    alerts,
    filter,
    prefsLoaded,
    loading,
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
