import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSeries } from './useSeries';
import { QueryWrapper } from '../queries/testUtils';
import type { SeriesAlertsResponse } from '../types';

/** Render useSeries inside a fresh QueryClient (its data now lives in the query cache). */
const renderUseSeries = () => renderHook(() => useSeries(), { wrapper: QueryWrapper });

const listSeries = vi.fn();
const listExpected = vi.fn();
const seriesAlerts = vi.fn();
const markAlertsSeen = vi.fn();
const getSeriesPreferences = vi.fn();
const putSeriesPreferences = vi.fn();
const setSeriesWatch = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    listSeries: (...a: unknown[]) => listSeries(...a),
    listExpected: (...a: unknown[]) => listExpected(...a),
    seriesAlerts: (...a: unknown[]) => seriesAlerts(...a),
    markAlertsSeen: (...a: unknown[]) => markAlertsSeen(...a),
    getSeriesPreferences: (...a: unknown[]) => getSeriesPreferences(...a),
    putSeriesPreferences: (...a: unknown[]) => putSeriesPreferences(...a),
    setSeriesWatch: (...a: unknown[]) => setSeriesWatch(...a),
  },
}));

const KEY_NV = 'new_volume|s1|Book Two|2026-01-01|announced';
const KEY_IP = 'in_progress|s2|2|0';

function alertResponse(seenKeys: string[] = []): SeriesAlertsResponse {
  const new_volume = [
    {
      kind: 'new_volume' as const,
      series_key: 's1',
      series_name: 'Watched Saga',
      message: 'New volume for Watched Saga: Book Two',
      detail: '2026-01-01',
      source_url: null,
      alert_key: KEY_NV,
      seen: seenKeys.includes(KEY_NV),
    },
  ];
  const in_progress = [
    {
      kind: 'in_progress' as const,
      series_key: 's2',
      series_name: 'In Prog',
      message: 'In Prog: 1 of 3 read',
      detail: '2 unread owned',
      source_url: null,
      alert_key: KEY_IP,
      seen: seenKeys.includes(KEY_IP),
    },
  ];
  const unseen = [...new_volume, ...in_progress].filter((a) => !a.seen).length;
  return { count: unseen, unseen_count: unseen, in_progress, new_volume };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  listSeries.mockReset().mockResolvedValue([]);
  listExpected.mockReset().mockResolvedValue([]);
  seriesAlerts.mockReset().mockResolvedValue(alertResponse());
  markAlertsSeen.mockReset().mockResolvedValue(alertResponse([KEY_NV, KEY_IP]));
  getSeriesPreferences.mockReset().mockResolvedValue({ filter: 'all', sort: null, default_search_lang: 'pl' });
  putSeriesPreferences.mockReset().mockResolvedValue({ filter: 'all', sort: null, default_search_lang: 'pl' });
  setSeriesWatch.mockReset();
});

describe('useSeries alerts', () => {
  it('exposes the badge as unseen_count from the server', async () => {
    const { result } = renderUseSeries();
    await waitFor(() => expect(result.current.alerts?.unseen_count).toBe(2));
  });

  it('dismiss-all calls the seen endpoint and drops the badge to 0', async () => {
    const { result } = renderUseSeries();
    await waitFor(() => expect(result.current.alerts?.unseen_count).toBe(2));
    // After the server marks everything seen, a later GET also reports all-seen (server truth),
    // so a background revalidation cannot resurrect the badge.
    seriesAlerts.mockResolvedValue(alertResponse([KEY_NV, KEY_IP]));
    await act(async () => {
      await result.current.dismissAlerts({ all: true });
    });
    expect(markAlertsSeen).toHaveBeenCalledWith({ all: true });
    await waitFor(() => expect(result.current.alerts?.unseen_count).toBe(0));
  });

  it('seen state survives a remount because it comes from the server', async () => {
    // Server already has both alerts seen.
    seriesAlerts.mockResolvedValue(alertResponse([KEY_NV, KEY_IP]));
    const first = renderUseSeries();
    await waitFor(() => expect(first.result.current.alerts?.unseen_count).toBe(0));
    first.unmount();
    // A fresh mount reads the same seen state (badge still 0), not a stale local value.
    const second = renderUseSeries();
    await waitFor(() => expect(second.result.current.alerts?.unseen_count).toBe(0));
  });

  it('rolls back the badge when the dismiss request fails', async () => {
    markAlertsSeen.mockRejectedValue(new Error('network'));
    const { result } = renderUseSeries();
    await waitFor(() => expect(result.current.alerts?.unseen_count).toBe(2));
    await act(async () => {
      await expect(result.current.dismissAlerts({ all: true })).rejects.toThrow('network');
    });
    // Optimistic update was rolled back to the server's last-known value.
    expect(result.current.alerts?.unseen_count).toBe(2);
  });
});

describe('useSeries preferences', () => {
  it('restores the active filter from the preferences endpoint', async () => {
    getSeriesPreferences.mockResolvedValue({ filter: 'watching', sort: null });
    const { result } = renderUseSeries();
    await waitFor(() => expect(result.current.filter).toBe('watching'));
  });

  it('persists a filter change to the preferences endpoint', async () => {
    vi.useFakeTimers();
    const { result } = renderUseSeries();
    await vi.waitFor(() => expect(result.current.prefsLoaded).toBe(true));
    act(() => {
      result.current.setFilter('complete');
    });
    expect(result.current.filter).toBe('complete');
    // The persist call is debounced by 250ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(putSeriesPreferences).toHaveBeenCalledWith({
      filter: 'complete',
      sort: null,
      default_search_lang: 'pl',
      add_mode: 'auto',
    });
  });
});
