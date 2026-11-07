import { useCallback, useEffect, useState } from 'react';

import { api } from '../services/api';
import type { ExpectedBook, SeriesAlertsResponse, SeriesSummary } from '../types';

export interface UseSeries {
  series: SeriesSummary[];
  expected: ExpectedBook[];
  alerts: SeriesAlertsResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setWatch: (key: string, watch: boolean) => Promise<void>;
  refresh: (key: string) => Promise<void>;
  removeExpected: (id: number) => Promise<void>;
}

/** Loads the Series tab data: series summaries, the waiting list and the alert feed. */
export function useSeries(): UseSeries {
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [expected, setExpected] = useState<ExpectedBook[]>([]);
  const [alerts, setAlerts] = useState<SeriesAlertsResponse | null>(null);
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
  }, []);

  const refresh = useCallback(async (key: string) => {
    const updated = await api.refreshSeries(key);
    setSeries((prev) => prev.map((s) => (s.series_key === key ? updated : s)));
  }, []);

  const removeExpected = useCallback(async (id: number) => {
    await api.deleteExpected(id);
    setExpected((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return { series, expected, alerts, loading, error, reload, setWatch, refresh, removeExpected };
}
