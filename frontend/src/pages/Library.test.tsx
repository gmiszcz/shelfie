import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from '../components/testHelpers';
import type { Book } from '../types';

const BOOKS: Book[] = [
  makeBook({
    id: 1,
    title: 'Dune',
    authors: ['Frank Herbert'],
    series: 'Dune',
    display_score: 4.8,
    stars: 5,
    finished_on: '2026-02-10',
    status: 'finished',
  }),
  makeBook({
    id: 2,
    title: 'Neuromancer',
    authors: ['William Gibson'],
    series: 'Sprawl',
    display_score: 3.2,
    stars: 3,
    finished_on: '2025-07-01',
    status: 'finished',
  }),
  makeBook({
    id: 3,
    title: 'Foundation',
    authors: ['Isaac Asimov'],
    series: 'Foundation',
    display_score: 4.0,
    stars: 4,
    finished_on: '2026-09-15',
    status: 'finished',
  }),
];

// Mock the API so useLibrary resolves without a backend.
vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listBooks: vi.fn(async () => BOOKS),
    updateBook: vi.fn(async (id: number) => BOOKS.find((b) => b.id === id)),
    deleteBook: vi.fn(async () => undefined),
    addBook: vi.fn(async () => BOOKS[0]),
    search: vi.fn(async () => ({ total_items: 0, items: [] })),
  },
}));

// eslint-disable-next-line import/first
import { Library } from './Library';
// eslint-disable-next-line import/first
import { SettingsProvider } from '../settings/SettingsContext';
// eslint-disable-next-line import/first
import {
  _resetRegistry,
  getAnchor,
  getAnchorState,
  invokeAnchor,
  setAnchor,
} from '../agent-ui';

async function renderLibrary() {
  render(
    <SettingsProvider>
      <Library />
    </SettingsProvider>,
  );
  await waitFor(() => expect(screen.getByText(/3 books/)).toBeTruthy());
}

/** The ids of the books currently visible, read from the list anchor. */
function visibleIds(): number[] {
  const res = getAnchorState('library.books');
  const value = res.value as { id: number }[] | undefined;
  return (value ?? []).map((b) => b.id);
}

afterEach(() => {
  cleanup();
  _resetRegistry();
});

describe('Library agent anchors', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetRegistry();
  });

  it('library.search filters the grid and reflects its value', async () => {
    await renderLibrary();
    await act(async () => {
      await setAnchor('library.search', 'dune');
    });
    await waitFor(() => expect(getAnchorState('library.search').value).toBe('dune'));
    expect(visibleIds()).toEqual([1]);
  });

  it('library.starFilter narrows to the whole-star band', async () => {
    await renderLibrary();
    await act(async () => {
      await setAnchor('library.starFilter', '5');
    });
    // 5-star band (4.6..5.0) keeps only Dune (display_score 4.8).
    await waitFor(() => expect(visibleIds()).toEqual([1]));
    expect(getAnchorState('library.starFilter').value).toBe('5');

    await act(async () => {
      await setAnchor('library.starFilter', '');
    });
    await waitFor(() => expect(visibleIds()).toEqual([1, 2, 3]));
  });

  it('library.filter applies a series facet and clears it', async () => {
    await renderLibrary();
    await act(async () => {
      await invokeAnchor('library.filter', 'apply', { series: 'Dune' });
    });
    await waitFor(() => expect(visibleIds()).toEqual([1]));

    await act(async () => {
      await invokeAnchor('library.filter', 'clear');
    });
    await waitFor(() => expect(visibleIds()).toEqual([1, 2, 3]));
  });

  it('library.books opens the detail dialog for a known id, errors on an unknown one', async () => {
    await renderLibrary();
    await act(async () => {
      await invokeAnchor('library.books', 'open', { id: 2 });
    });
    await waitFor(() => expect(getAnchorState('library.dialogs').value).toBe('detail'));

    const bad = await invokeAnchor('library.books', 'open', { id: 999 });
    expect(bad.ok).toBe(false);
  });

  it('library.addBook(search) opens the search dialog with the query typed in', async () => {
    await renderLibrary();
    await act(async () => {
      await invokeAnchor('library.addBook', 'search', { query: 'sci-fi' });
    });
    await waitFor(() => expect(getAnchorState('library.dialogs').value).toBe('search'));
    await waitFor(() => expect(screen.getByDisplayValue('sci-fi')).toBeTruthy());
  });

  it('library.addBook(manual) opens the manual form', async () => {
    await renderLibrary();
    await act(async () => {
      await invokeAnchor('library.addBook', 'manual');
    });
    await waitFor(() => expect(getAnchorState('library.dialogs').value).toBe('form'));
  });

  it('library.dialogs(close) closes any open dialog', async () => {
    await renderLibrary();
    await act(async () => {
      await invokeAnchor('library.books', 'open', { id: 1 });
    });
    await waitFor(() => expect(getAnchorState('library.dialogs').value).toBe('detail'));
    await act(async () => {
      await invokeAnchor('library.dialogs', 'close');
    });
    await waitFor(() => expect(getAnchorState('library.dialogs').value).toBe('none'));
  });

  it('library.books lists every visible book for the agent to open', async () => {
    await renderLibrary();
    await waitFor(() => expect(visibleIds()).toEqual([1, 2, 3]));
  });
});

describe('Library structured facet anchors', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetRegistry();
  });

  it('library.finishedYear offers the years present in the data, newest first', async () => {
    await renderLibrary();
    const res = getAnchorState('library.finishedYear');
    // The anchor's own value is the current selection (empty); options come from describe.
    expect(res.value).toBe('');
    const anchor = getAnchor('library.finishedYear')!;
    const opts = anchor.options!().map((o) => o.value);
    expect(opts).toEqual(['', '2026', '2025']);
  });

  it('library.finishedYear filters the grid to books finished in that year', async () => {
    await renderLibrary();
    await act(async () => {
      await setAnchor('library.finishedYear', '2026');
    });
    // Dune (2026) and Foundation (2026), not Neuromancer (2025).
    await waitFor(() => expect(visibleIds()).toEqual([1, 3]));

    await act(async () => {
      await setAnchor('library.finishedYear', '2025');
    });
    await waitFor(() => expect(visibleIds()).toEqual([2]));

    await act(async () => {
      await setAnchor('library.finishedYear', '');
    });
    await waitFor(() => expect(visibleIds()).toEqual([1, 2, 3]));
  });

  it('library.finishedYear rejects a year not in the options', async () => {
    await renderLibrary();
    const res = await setAnchor('library.finishedYear', '1999');
    expect(res.ok).toBe(false);
    expect(res.valid).toContain('2026');
  });

  it('structured facets combine (series + finishedYear) and show in the filter chip', async () => {
    await renderLibrary();
    await act(async () => {
      await setAnchor('library.series', 'Foundation');
      await setAnchor('library.finishedYear', '2026');
    });
    await waitFor(() => expect(visibleIds()).toEqual([3]));
    await waitFor(() => expect(screen.getByText(/Filtered by assistant/)).toBeTruthy());
  });
});
