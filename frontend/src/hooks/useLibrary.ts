import { useCallback, useEffect, useState } from 'react';

import { api } from '../services/api';
import type { Book, ReadingStatus, VolumeSearchResult } from '../types';

export interface UseLibrary {
  books: Book[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  add: (volume: VolumeSearchResult, status?: ReadingStatus) => Promise<Book>;
  update: (id: number, changes: { status?: ReadingStatus; stars?: number | null }) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export function useLibrary(): UseLibrary {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBooks(await api.listBooks());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async (volume: VolumeSearchResult, status: ReadingStatus = 'want') => {
    const book = await api.addBook(volume, status);
    setBooks((prev) => [book, ...prev]);
    return book;
  }, []);

  const update = useCallback(
    async (id: number, changes: { status?: ReadingStatus; stars?: number | null }) => {
      const updated = await api.updateBook(id, changes);
      setBooks((prev) => prev.map((b) => (b.id === id ? updated : b)));
    },
    [],
  );

  const remove = useCallback(async (id: number) => {
    await api.deleteBook(id);
    setBooks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  return { books, loading, error, reload, add, update, remove };
}
