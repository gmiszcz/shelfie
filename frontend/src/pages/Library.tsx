import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { BookGrid } from '../components/BookGrid';
import { SearchDialog } from '../components/SearchDialog';
import { useLibrary } from '../hooks/useLibrary';
import type { Book, ReadingStatus, VolumeSearchResult } from '../types';

export function Library() {
  const { books, loading, error, add, update, remove } = useLibrary();
  const [selected, setSelected] = useState<Book | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const toast = useRef<Toast>(null);

  const existingVolumeIds = useMemo(
    () => new Set(books.map((b) => b.google_volume_id).filter((v): v is string => v != null)),
    [books],
  );

  const notifyError = (message: string) =>
    toast.current?.show({ severity: 'error', summary: 'Error', detail: message });

  const handleAdd = async (volume: VolumeSearchResult) => {
    try {
      const book = await add(volume);
      toast.current?.show({ severity: 'success', summary: 'Added', detail: book.title });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not add book');
    }
  };

  const handleStatus = async (id: number, status: ReadingStatus) => {
    try {
      await update(id, { status });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update status');
    }
  };

  const handleStars = async (id: number, stars: number | null) => {
    try {
      await update(id, { stars });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, stars } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update rating');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await remove(id);
      setSelected(null);
      toast.current?.show({ severity: 'info', summary: 'Removed' });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not remove book');
    }
  };

  return (
    <>
      <Toast ref={toast} position="bottom-right" />
      <div className="toolbar">
        <Button
          label="Add book"
          icon="pi pi-plus"
          onClick={() => setSearchOpen(true)}
        />
        <span style={{ color: 'var(--app-text-muted)' }}>
          {loading ? 'Loading…' : `${books.length} book${books.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      <BookGrid books={books} loading={loading} onOpen={setSelected} />

      <BookDetailDialog
        book={selected}
        onHide={() => setSelected(null)}
        onStatus={handleStatus}
        onStars={handleStars}
        onDelete={handleDelete}
      />

      <SearchDialog
        visible={searchOpen}
        onHide={() => setSearchOpen(false)}
        onAdd={handleAdd}
        existingVolumeIds={existingVolumeIds}
      />
    </>
  );
}
