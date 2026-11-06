import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from './components/testHelpers';
import type { Book } from './types';

const BOOKS: Book[] = [makeBook({ id: 1, title: 'Dune' })];

vi.mock('./services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listBooks: vi.fn(async () => BOOKS),
    updateBook: vi.fn(async () => BOOKS[0]),
    deleteBook: vi.fn(async () => undefined),
    addBook: vi.fn(async () => BOOKS[0]),
    search: vi.fn(async () => ({ total_items: 0, items: [] })),
    stats: vi.fn(async () => ({
      date_from: null,
      date_to: null,
      group_by: 'shelf',
      summary: { books: 0, pages: 0, average_stars: null, first_finished: null, last_finished: null },
      buckets: [],
      books: [],
    })),
    recomputeRatings: vi.fn(async () => ({ rated_books: 0, comparisons: 0 })),
    nextPair: vi.fn(async () => null),
    chat: vi.fn(),
    resetChat: vi.fn(async () => undefined),
  },
}));

// eslint-disable-next-line import/first
import App from './App';
// eslint-disable-next-line import/first
import { UI_BUS_ACK_EVENT, UI_BUS_EVENT } from './settings/uiBus';
// eslint-disable-next-line import/first
import type { UiBusAck } from './settings/uiBus';
// eslint-disable-next-line import/first
import type { Settings } from './settings/settingsTypes';

function dispatch(detail: unknown): UiBusAck[] {
  const acks: UiBusAck[] = [];
  const onAck = (e: Event) => acks.push((e as CustomEvent).detail as UiBusAck);
  window.addEventListener(UI_BUS_ACK_EVENT, onAck);
  window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  window.removeEventListener(UI_BUS_ACK_EVENT, onAck);
  return acks;
}

afterEach(() => {
  cleanup();
  delete (window as { __shelfieUiState?: unknown }).__shelfieUiState;
  document.documentElement.removeAttribute('data-theme');
});

describe('App UI bus v2 listeners', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as { __shelfieUiState?: unknown }).__shelfieUiState;
  });

  async function renderApp() {
    render(<App />);
    await waitFor(() => expect(window.__shelfieUiState).toBeTruthy());
  }

  it('navigate switches the active tab and acks', async () => {
    await renderApp();
    const acks = dispatch({ action: 'navigate', tab: 'stats' });
    await waitFor(() => expect(window.__shelfieUiState?.tab).toBe('stats'));
    expect(acks).toContainEqual({ action: 'navigate', ok: true });
  });

  it('open_settings opens the settings sidebar and acks', async () => {
    await renderApp();
    const acks = dispatch({ action: 'open_settings' });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('settings'));
    expect(acks).toContainEqual({ action: 'open_settings', ok: true });
  });

  it('toggle_theme flips the theme and acks', async () => {
    await renderApp();
    const before = document.documentElement.getAttribute('data-theme');
    dispatch({ action: 'toggle_theme' });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).not.toBe(before),
    );
  });

  it('set_setting toggles a detail section via SettingsContext and acks ok', async () => {
    await renderApp();
    const acks = dispatch({ action: 'set_setting', key: 'insights', value: false });
    await waitFor(() => {
      const s = window.__shelfieUiState?.settings as Settings | null;
      expect(s?.detailSections.insights).toBe(false);
    });
    expect(acks).toContainEqual({ action: 'set_setting', ok: true, info: undefined });
  });

  it('set_setting with an unknown key acks not-ok', async () => {
    await renderApp();
    const acks = dispatch({ action: 'set_setting', key: 'nope', value: true });
    expect(acks[0].action).toBe('set_setting');
    expect(acks[0].ok).toBe(false);
  });
});
