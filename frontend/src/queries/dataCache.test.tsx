import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from '../components/testHelpers';
import type { Book } from '../types';

const listBooks = vi.fn();
const addBook = vi.fn();
const updateBook = vi.fn();
const deleteBook = vi.fn();

vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listBooks: (...a: unknown[]) => listBooks(...a),
    addBook: (...a: unknown[]) => addBook(...a),
    updateBook: (...a: unknown[]) => updateBook(...a),
    deleteBook: (...a: unknown[]) => deleteBook(...a),
  },
}));

// eslint-disable-next-line import/first
import { useBooksQuery } from './useBooksQuery';
// eslint-disable-next-line import/first
import { useLibrary } from '../hooks/useLibrary';
// eslint-disable-next-line import/first
import { STALE_TIME } from './queryClient';

const BOOKS: Book[] = [
  makeBook({ id: 1, title: 'Dune', favourite: false }),
  makeBook({ id: 2, title: 'Neuromancer', favourite: false }),
];

/** A client with the app's real staleTime so the "no refetch when fresh" test is meaningful. */
function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: STALE_TIME, refetchOnMount: true },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  listBooks.mockReset().mockResolvedValue(BOOKS);
  addBook.mockReset();
  updateBook.mockReset();
  deleteBook.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('book list cache (stale-while-revalidate)', () => {
  it('does NOT refetch on a tab switch while the data is fresh', async () => {
    const client = freshClient();
    const wrapper = wrapperFor(client);

    // First "tab visit": loads the list once.
    const first = renderHook(() => useBooksQuery(), { wrapper });
    await waitFor(() => expect(first.result.current.data).toHaveLength(2));
    expect(listBooks).toHaveBeenCalledTimes(1);
    first.unmount(); // leave the tab

    // Return to the tab (remount against the SAME client). Data is still fresh → no refetch.
    const second = renderHook(() => useBooksQuery(), { wrapper });
    // Data is available immediately from cache (no loading flash).
    expect(second.result.current.data).toHaveLength(2);
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(listBooks).toHaveBeenCalledTimes(1);
  });

  it('shows cached data immediately, then refetches in the background when stale', async () => {
    const client = freshClient();
    const wrapper = wrapperFor(client);

    // Seed the cache as if restored from IndexedDB on a cold start, and mark it stale
    // (updatedAt in the past) so a mount triggers a background refetch.
    client.setQueryData(['user', 1, 'books'], BOOKS, { updatedAt: Date.now() - STALE_TIME - 1000 });

    // The network returns a DIFFERENT (updated) list, resolved after a tick.
    const updated = [...BOOKS, makeBook({ id: 3, title: 'Snow Crash' })];
    listBooks.mockResolvedValueOnce(updated);

    const { result } = renderHook(() => useBooksQuery(), { wrapper });

    // The cached list is on screen BEFORE the network resolves (no spinner, no undefined).
    expect(result.current.data).toHaveLength(2);
    expect(result.current.isPending).toBe(false);

    // The background refetch then reconciles to the fresh list.
    await waitFor(() => expect(result.current.data).toHaveLength(3));
    expect(listBooks).toHaveBeenCalledTimes(1);
  });
});

describe('useLibrary mutations update the cache immediately', () => {
  it('delete removes the row optimistically (before the request resolves)', async () => {
    const client = freshClient();
    const wrapper = wrapperFor(client);
    let resolveDelete: () => void = () => {};
    deleteBook.mockReturnValue(new Promise<void>((r) => (resolveDelete = () => r())));

    const { result } = renderHook(() => useLibrary(), { wrapper });
    await waitFor(() => expect(result.current.books).toHaveLength(2));

    let removePromise: Promise<void> = Promise.resolve();
    act(() => {
      removePromise = result.current.remove(1);
    });
    // Optimistic: the grid already lost book 1 while the DELETE is still in flight.
    await waitFor(() => expect(result.current.books.map((b) => b.id)).toEqual([2]));

    await act(async () => {
      resolveDelete();
      await removePromise;
    });
    expect(result.current.books.map((b) => b.id)).toEqual([2]);
  });

  it('update writes the changed book into the cache at once', async () => {
    const client = freshClient();
    const wrapper = wrapperFor(client);
    const renamed = { ...BOOKS[0], title: 'Dune (revised)' };
    updateBook.mockResolvedValue(renamed);

    const { result } = renderHook(() => useLibrary(), { wrapper });
    await waitFor(() => expect(result.current.books).toHaveLength(2));

    // After the PATCH the authoritative list also reflects the rename (the server copy),
    // so the post-mutation invalidate+refetch stays consistent with the optimistic write.
    listBooks.mockResolvedValue([renamed, BOOKS[1]]);

    await act(async () => {
      await result.current.update(1, { title: 'Dune (revised)' });
    });
    await waitFor(() =>
      expect(result.current.books.find((b) => b.id === 1)?.title).toBe('Dune (revised)'),
    );
  });
});

describe('cache clear (logout / user switch)', () => {
  it('clearing the client drops the cached list so it is refetched next mount', async () => {
    const client = freshClient();
    const wrapper = wrapperFor(client);

    const first = renderHook(() => useBooksQuery(), { wrapper });
    await waitFor(() => expect(first.result.current.data).toHaveLength(2));
    expect(listBooks).toHaveBeenCalledTimes(1);
    first.unmount();

    // Logout wipes the cache.
    act(() => {
      client.clear();
    });

    // Next visit has no cached data and must fetch again.
    const second = renderHook(() => useBooksQuery(), { wrapper });
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => expect(second.result.current.data).toHaveLength(2));
    expect(listBooks).toHaveBeenCalledTimes(2);
  });
});
