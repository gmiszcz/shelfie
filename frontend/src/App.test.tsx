import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from './components/testHelpers';
import type { Book } from './types';

const BOOKS: Book[] = [makeBook({ id: 1, title: 'Dune', series: 'Dune', stars: 5, display_score: 4.8 })];

vi.mock('./services/api', () => ({
  ApiError: class ApiError extends Error {},
  onUnauthorized: () => () => {},
  api: {
    // Auth: the AuthProvider loads "who am I" on mount; resolve to an admin so
    // the app shell renders for the anchor-coverage guards.
    me: vi.fn(async () => ({ id: 1, email: 'admin@shelfie.app', display_name: 'Admin', is_admin: true })),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    listUsers: vi.fn(async () => []),
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
import { AuthProvider } from './auth';
// eslint-disable-next-line import/first
import {
  _resetRegistry,
  describeUi,
  getAnchor,
  getAnchorState,
  invokeAnchor,
  navigate,
  setAnchor,
} from './agent-ui';

/** Every nav tab the app ships with — each MUST register a tab in the schema. */
const REQUIRED_TABS = ['library', 'stats', 'ranking'];

/**
 * Every interactive control the universal agent must be able to reach, by anchor
 * id, grouped by the tab that must be mounted for it to register. A new
 * interactive control MUST call `useAgentAnchor` (see
 * docs/features/ui-agent-registry.md) and be added here, so this guard fails
 * until it is wired. Anchors register on mount, so the guard navigates to each
 * tab before checking that tab's controls. Settings toggles (one per field) are
 * checked separately.
 */
const GLOBAL_ANCHORS = ['nav.tab', 'theme.toggle', 'settings.sidebar', 'settings.showAllDetails'];
const TAB_ANCHORS: Record<string, string[]> = {
  library: [
    'library.search',
    'library.starFilter',
    'library.filter',
    'library.books',
    'library.addBook',
    'library.dialogs',
    'library.finishedYear',
    'library.startedYear',
    'library.publishedYear',
    'library.status',
    'library.shelf',
    'library.tag',
    'library.series',
    'library.author',
  ],
  stats: ['stats.period', 'stats.group', 'stats.metric', 'stats.tableSearch'],
  ranking: ['ranking.search', 'ranking.category', 'ranking.focus'],
};

afterEach(() => {
  cleanup();
  _resetRegistry();
  document.documentElement.removeAttribute('data-theme');
});

async function renderApp() {
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
  // Wait until the registry has the nav anchor (App mounted) and the library tab mounted.
  await waitFor(() => expect(getAnchor('nav.tab')).toBeTruthy());
  await waitFor(() => expect(getAnchor('library.search')).toBeTruthy());
}

describe('agent-anchor coverage guard', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetRegistry();
  });

  it('registers a tab in the schema for every nav tab', async () => {
    await renderApp();
    const schema = describeUi();
    for (const tab of REQUIRED_TABS) {
      expect(schema.tabs.find((t) => t.id === tab), `missing tab ${tab}`).toBeTruthy();
    }
    expect(schema.activeTab).toBe('library');
  });

  it('registers an anchor for every known interactive control (mounting each tab)', async () => {
    await renderApp();
    // Global anchors are always present.
    for (const id of GLOBAL_ANCHORS) {
      expect(getAnchor(id), `missing global anchor "${id}"`).toBeTruthy();
    }
    // Each tab's controls register once that tab is mounted.
    for (const [tab, ids] of Object.entries(TAB_ANCHORS)) {
      await act(async () => {
        await navigate(tab);
      });
      await waitFor(() => expect(getAnchor(ids[0])).toBeTruthy());
      for (const id of ids) {
        expect(
          getAnchor(id),
          `missing anchor "${id}" on tab "${tab}" — did a control forget useAgentAnchor?`,
        ).toBeTruthy();
      }
    }
  });

  it('registers one toggle anchor per settings card field and detail section', async () => {
    await renderApp();
    // A representative sample from each settings group.
    for (const id of [
      'settings.cardFields.author',
      'settings.cardFields.pageCount',
      'settings.detailSections.insights',
      'settings.detailSections.notes',
    ]) {
      expect(getAnchor(id), `missing settings anchor "${id}"`).toBeTruthy();
    }
  });
});

describe('driving the app through the registry (no agent-side per-control code)', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetRegistry();
  });

  it('navigate switches the active tab', async () => {
    await renderApp();
    await act(async () => {
      await navigate('stats');
    });
    await waitFor(() => expect(describeUi().activeTab).toBe('stats'));
  });

  it('set drives the library search box', async () => {
    await renderApp();
    await act(async () => {
      await setAnchor('library.search', 'dune');
    });
    await waitFor(() => expect(getAnchorState('library.search').value).toBe('dune'));
  });

  it('set toggles a display setting without the sidebar being open', async () => {
    await renderApp();
    await act(async () => {
      await setAnchor('settings.detailSections.insights', false);
    });
    await waitFor(() =>
      expect(getAnchorState('settings.detailSections.insights').value).toBe(false),
    );
  });

  it('invoke opens the settings sidebar', async () => {
    await renderApp();
    await act(async () => {
      await invokeAnchor('settings.sidebar', 'open');
    });
    await waitFor(() => expect(getAnchorState('settings.sidebar').value).toBe('open'));
  });

  it('set changes the theme', async () => {
    await renderApp();
    const before = getAnchorState('theme.toggle').value;
    await act(async () => {
      await setAnchor('theme.toggle', before === 'dark' ? 'light' : 'dark');
    });
    await waitFor(() => expect(getAnchorState('theme.toggle').value).not.toBe(before));
  });
});
