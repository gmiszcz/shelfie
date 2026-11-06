import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatch,
  dispatchAndWait,
  readUiState,
  UI_BUS_ACK_EVENT,
  UI_BUS_EVENT,
  type UiBusDetail,
} from './bus';

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__shelfieUiState;
});

describe('readUiState', () => {
  it('returns {} when no state is exposed', () => {
    expect(readUiState()).toEqual({});
  });

  it('returns the exposed snapshot', () => {
    window.__shelfieUiState = { tab: 'ranking', search: 'dune', starFilter: 5 };
    expect(readUiState()).toEqual({ tab: 'ranking', search: 'dune', starFilter: 5 });
  });
});

describe('dispatch', () => {
  it('fires a shelfie:ui CustomEvent with the detail', () => {
    const seen: UiBusDetail[] = [];
    const onBus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    dispatch({ action: 'navigate', tab: 'library' });
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(seen).toEqual([{ action: 'navigate', tab: 'library' }]);
  });
});

describe('dispatchAndWait', () => {
  it('resolves with the ack when a listener answers for the same action', async () => {
    const onBus = (e: Event) => {
      const detail = (e as CustomEvent).detail as UiBusDetail;
      window.dispatchEvent(
        new CustomEvent(UI_BUS_ACK_EVENT, {
          detail: { action: detail.action, ok: true, info: '5 books' },
        }),
      );
    };
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    const ack = await dispatchAndWait({ action: 'set_star_filter', stars: 5 });
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(ack).toEqual({ action: 'set_star_filter', ok: true, info: '5 books' });
  });

  it('ignores an ack for a different action and times out to ok', async () => {
    vi.useFakeTimers();
    const onBus = (e: Event) => {
      // Wrong action: must be ignored.
      void e;
      window.dispatchEvent(
        new CustomEvent(UI_BUS_ACK_EVENT, { detail: { action: 'navigate', ok: true } }),
      );
    };
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    const promise = dispatchAndWait({ action: 'set_search', query: 'x' }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ack = await promise;
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    vi.useRealTimers();
    expect(ack.ok).toBe(true);
    expect(ack.info).toMatch(/timeout/);
  });

  it('times out to a synthetic ok when no listener acks', async () => {
    vi.useFakeTimers();
    const promise = dispatchAndWait({ action: 'toggle_theme' }, 500);
    await vi.advanceTimersByTimeAsync(500);
    const ack = await promise;
    vi.useRealTimers();
    expect(ack).toEqual({ action: 'toggle_theme', ok: true, info: 'no ack (timeout)' });
  });
});
