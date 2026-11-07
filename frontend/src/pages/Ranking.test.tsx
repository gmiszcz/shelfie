import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from '../components/testHelpers';
import type { Book, RatingPair } from '../types';

const BOOKS: Book[] = [
  makeBook({ id: 1, title: 'Dune', authors: ['Frank Herbert'], stars: 5, shelves: ['sci-fi'] }),
  makeBook({ id: 2, title: 'Neuromancer', authors: ['William Gibson'], stars: 4, shelves: ['sci-fi'] }),
];

const PAIR: RatingPair = { left: BOOKS[0], right: BOOKS[1] };

// Mock the API so the Ranking page resolves without a backend.
vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listBooks: vi.fn(async () => BOOKS),
    nextPair: vi.fn(async () => PAIR),
    compare: vi.fn(async () => undefined),
    recomputeRatings: vi.fn(async () => ({ rated_books: 2, comparisons: 0 })),
  },
}));

// eslint-disable-next-line import/first
import { Ranking } from './Ranking';
// eslint-disable-next-line import/first
import { _resetRegistry, getAnchor, getAnchorState, setAnchor } from '../agent-ui';

async function renderRanking() {
  render(<Ranking />);
  await waitFor(() => expect(screen.getByText(/2 rated books/)).toBeTruthy());
}

afterEach(() => {
  cleanup();
  _resetRegistry();
});

describe('Ranking page', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetRegistry();
  });

  it('renders the shared SearchInput (role=search), not the old .rank-search span', async () => {
    const { container } = render(<Ranking />);
    await waitFor(() => expect(screen.getByText(/2 rated books/)).toBeTruthy());
    expect(container.querySelector('.ui-search')).toBeTruthy();
    expect(screen.getByRole('search')).toBeTruthy();
    expect(container.querySelector('.p-input-icon-left.rank-search')).toBeNull();
    expect(container.querySelector('.rank-search-clear')).toBeNull();
  });

  it('registers the ranking search, category and focus anchors', async () => {
    await renderRanking();
    expect(getAnchor('ranking.search')).toBeTruthy();
    expect(getAnchor('ranking.category')).toBeTruthy();
    expect(getAnchor('ranking.focus')).toBeTruthy();
  });

  it('ranking.search fills the search box', async () => {
    await renderRanking();
    await act(async () => {
      await setAnchor('ranking.search', 'dune');
    });
    await waitFor(() => expect(screen.getByDisplayValue('dune')).toBeTruthy());
    expect(getAnchorState('ranking.search').value).toBe('dune');
  });

  it('ranking.search with an empty value clears the search', async () => {
    await renderRanking();
    await act(async () => {
      await setAnchor('ranking.search', 'dune');
    });
    await waitFor(() => expect(screen.getByDisplayValue('dune')).toBeTruthy());
    await act(async () => {
      await setAnchor('ranking.search', '');
    });
    await waitFor(() => expect(screen.queryByDisplayValue('dune')).toBeNull());
  });
});
