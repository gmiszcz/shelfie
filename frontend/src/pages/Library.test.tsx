import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  }),
  makeBook({
    id: 2,
    title: 'Neuromancer',
    authors: ['William Gibson'],
    series: 'Sprawl',
    display_score: 3.2,
    stars: 3,
  }),
  makeBook({
    id: 3,
    title: 'Foundation',
    authors: ['Isaac Asimov'],
    series: 'Foundation',
    display_score: 4.0,
    stars: 4,
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
import { UI_BUS_ACK_EVENT, UI_BUS_EVENT } from '../settings/uiBus';
// eslint-disable-next-line import/first
import type { UiBusAck } from '../settings/uiBus';

function dispatch(detail: unknown): UiBusAck[] {
  const acks: UiBusAck[] = [];
  const onAck = (e: Event) => acks.push((e as CustomEvent).detail as UiBusAck);
  window.addEventListener(UI_BUS_ACK_EVENT, onAck);
  window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  window.removeEventListener(UI_BUS_ACK_EVENT, onAck);
  return acks;
}

async function renderLibrary() {
  render(
    <SettingsProvider>
      <Library />
    </SettingsProvider>,
  );
  // Wait until the library has loaded (count label reflects all books).
  await waitFor(() => expect(screen.getByText(/3 books/)).toBeTruthy());
}

afterEach(() => {
  cleanup();
  delete (window as { __shelfieUiState?: unknown }).__shelfieUiState;
});

describe('Library UI bus v2 listeners', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as { __shelfieUiState?: unknown }).__shelfieUiState;
  });

  it('set_search updates the search box and the state snapshot, and acks', async () => {
    await renderLibrary();
    const acks = dispatch({ action: 'set_search', query: 'dune' });
    await waitFor(() => expect(window.__shelfieUiState?.search).toBe('dune'));
    expect(window.__shelfieUiState?.visibleBookIds).toEqual([1]);
    expect(acks).toContainEqual({ action: 'set_search', ok: true, info: undefined });
  });

  it('set_star_filter narrows to the whole-star band and acks', async () => {
    await renderLibrary();
    dispatch({ action: 'set_star_filter', stars: 5 });
    // 5-star band (4.6..5.0) keeps only Dune (display_score 4.8).
    await waitFor(() => expect(window.__shelfieUiState?.starFilter).toBe(5));
    expect(window.__shelfieUiState?.visibleBookIds).toEqual([1]);

    const acks = dispatch({ action: 'set_star_filter', stars: null });
    await waitFor(() => expect(window.__shelfieUiState?.starFilter).toBeNull());
    expect(window.__shelfieUiState?.visibleBookIds).toEqual([1, 2, 3]);
    expect(acks).toContainEqual({ action: 'set_star_filter', ok: true, info: undefined });
  });

  it('open_book opens the detail dialog for a known id and acks ok', async () => {
    await renderLibrary();
    const acks = dispatch({ action: 'open_book', book_id: 2 });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('detail'));
    expect(acks).toContainEqual({ action: 'open_book', ok: true, info: undefined });
  });

  it('open_book with an unknown id acks not-ok', async () => {
    await renderLibrary();
    const acks = dispatch({ action: 'open_book', book_id: 999 });
    expect(acks[0].action).toBe('open_book');
    expect(acks[0].ok).toBe(false);
  });

  it('open_add_book(search) opens the search dialog with the query typed in', async () => {
    await renderLibrary();
    const acks = dispatch({ action: 'open_add_book', mode: 'search', query: 'sci-fi' });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('search'));
    await waitFor(() => expect(screen.getByDisplayValue('sci-fi')).toBeTruthy());
    expect(acks).toContainEqual({ action: 'open_add_book', ok: true, info: undefined });
  });

  it('open_add_book(manual) opens the manual form and acks', async () => {
    await renderLibrary();
    const acks = dispatch({ action: 'open_add_book', mode: 'manual' });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('form'));
    expect(acks).toContainEqual({ action: 'open_add_book', ok: true, info: undefined });
  });

  it('close_dialogs closes any open dialog', async () => {
    await renderLibrary();
    dispatch({ action: 'open_book', book_id: 1 });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('detail'));
    dispatch({ action: 'close_dialogs' });
    await waitFor(() => expect(window.__shelfieUiState?.openDialog).toBe('none'));
  });

  it('keeps visibleBookIds in the snapshot for the agent to read', async () => {
    await renderLibrary();
    await waitFor(() => expect(window.__shelfieUiState?.visibleBookIds).toEqual([1, 2, 3]));
  });
});
