import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api } from '../services/api';
import { queryKeys, useBooksQuery, useQueryUserId } from '../queries';
import type { Book, BookPatch, ReadingStatus, VolumeSearchResult } from '../types';

export interface UseLibrary {
  books: Book[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  add: (volume: VolumeSearchResult, status?: ReadingStatus) => Promise<Book>;
  update: (id: number, changes: BookPatch) => Promise<void>;
  remove: (id: number) => Promise<void>;
  /** Insert a newly created book, or replace an existing one by id. */
  upsert: (book: Book) => void;
}

/**
 * The library hook, now backed by the shared React Query cache (query key
 * `['user', id, 'books']`). The public shape is unchanged so pages/tests keep working, but
 * the data is the one persisted, stale-while-revalidate book list — switching tabs no longer
 * refetches, and the last data shows instantly on a cold start.
 *
 * Mutations write the cache optimistically with `setQueryData` (instant UI) and then
 * invalidate the books query so the authoritative server copy is reconciled in the background.
 */
export function useLibrary(): UseLibrary {
  const userId = useQueryUserId();
  const queryClient = useQueryClient();
  const booksKey = queryKeys.books(userId);
  const query = useBooksQuery();

  const books = query.data ?? [];

  const setBooks = useCallback(
    (updater: (prev: Book[]) => Book[]) => {
      queryClient.setQueryData<Book[]>(booksKey, (prev) => updater(prev ?? []));
    },
    [queryClient, booksKey],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: booksKey });
  }, [queryClient, booksKey]);

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: booksKey });
  }, [queryClient, booksKey]);

  const addMutation = useMutation({
    mutationFn: ({ volume, status }: { volume: VolumeSearchResult; status: ReadingStatus }) =>
      api.addBook(volume, status),
    onSuccess: (book) => {
      setBooks((prev) => [book, ...prev]);
      invalidate();
    },
  });

  const add = useCallback(
    async (volume: VolumeSearchResult, status: ReadingStatus = 'want') => {
      return addMutation.mutateAsync({ volume, status });
    },
    [addMutation],
  );

  const updateMutation = useMutation({
    mutationFn: ({ id, changes }: { id: number; changes: BookPatch }) =>
      api.updateBook(id, changes),
    onSuccess: (updated) => {
      setBooks((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      invalidate();
    },
  });

  const update = useCallback(
    async (id: number, changes: BookPatch) => {
      await updateMutation.mutateAsync({ id, changes });
    },
    [updateMutation],
  );

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.deleteBook(id),
    onMutate: (id: number) => {
      // Optimistic: drop the row at once so the grid updates before the network answers.
      setBooks((prev) => prev.filter((b) => b.id !== id));
    },
    onSettled: () => invalidate(),
  });

  const remove = useCallback(
    async (id: number) => {
      await removeMutation.mutateAsync(id);
    },
    [removeMutation],
  );

  const upsert = useCallback(
    (book: Book) => {
      setBooks((prev) =>
        prev.some((b) => b.id === book.id)
          ? prev.map((b) => (b.id === book.id ? book : b))
          : [book, ...prev],
      );
    },
    [setBooks],
  );

  return {
    books,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    reload,
    add,
    update,
    remove,
    upsert,
  };
}
