import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const UI_BUS_EVENT = 'shelfie:ui';
const UI_BUS_ACK_EVENT = 'shelfie:ui:ack';

interface Ack {
  action: string;
  ok: boolean;
  info?: string;
}

function dispatch(detail: unknown): Ack[] {
  const acks: Ack[] = [];
  const onAck = (e: Event) => acks.push((e as CustomEvent).detail as Ack);
  window.addEventListener(UI_BUS_ACK_EVENT, onAck);
  window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  window.removeEventListener(UI_BUS_ACK_EVENT, onAck);
  return acks;
}

async function renderRanking() {
  render(<Ranking />);
  await waitFor(() => expect(screen.getByText(/2 rated books/)).toBeTruthy());
}

afterEach(() => cleanup());

describe('Ranking page', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the shared SearchInput (role=search), not the old .rank-search span', async () => {
    const { container } = render(<Ranking />);
    await waitFor(() => expect(screen.getByText(/2 rated books/)).toBeTruthy());
    // The shared component exposes role="search" with the .ui-search class.
    expect(container.querySelector('.ui-search')).toBeTruthy();
    expect(screen.getByRole('search')).toBeTruthy();
    // The old custom wrapper is gone.
    expect(container.querySelector('.p-input-icon-left.rank-search')).toBeNull();
    expect(container.querySelector('.rank-search-clear')).toBeNull();
  });

  it('UI-bus "ranking" action fills the search box and acks ok', async () => {
    await renderRanking();
    const acks = dispatch({ action: 'ranking', query: 'dune' });
    await waitFor(() => expect(screen.getByDisplayValue('dune')).toBeTruthy());
    expect(acks).toContainEqual({ action: 'ranking', ok: true, info: 'searching for "dune"' });
  });

  it('UI-bus "ranking" with an empty query clears the search and acks', async () => {
    await renderRanking();
    dispatch({ action: 'ranking', query: 'dune' });
    await waitFor(() => expect(screen.getByDisplayValue('dune')).toBeTruthy());

    const acks = dispatch({ action: 'ranking', query: '' });
    await waitFor(() => expect(screen.queryByDisplayValue('dune')).toBeNull());
    expect(acks).toContainEqual({ action: 'ranking', ok: true, info: 'cleared the ranking search' });
  });
});
