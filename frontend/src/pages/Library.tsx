import { Button } from 'primereact/button';
import { Chip } from 'primereact/chip';
import { InputText } from 'primereact/inputtext';
import { Toast } from 'primereact/toast';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { BookFormDialog } from '../components/BookFormDialog';
import { BookGrid } from '../components/BookGrid';
import { SearchDialog } from '../components/SearchDialog';
import { StarFilter } from '../components/StarFilter';
import type { ScoreBounds } from '../components/StarFilter';
import { useLibrary } from '../hooks/useLibrary';
import { filterByScore } from '../ranking';
import { applyFilter, describeFilter, isEmptyFilter } from '../settings/libraryFilter';
import type { LibraryFilter } from '../settings/libraryFilter';
import { UI_BUS_EVENT, parseUiBusEvent } from '../settings/uiBus';
import type { Book, BookInput, ReadingStatus, VolumeSearchResult } from '../types';

interface FormTarget {
  mode: 'create' | 'edit';
  bookId?: number;
  initial?: Partial<BookInput>;
}

export function Library() {
  const { books, loading, error, add, update, remove, upsert } = useLibrary();
  const [selected, setSelected] = useState<Book | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  // Free-text search box (client-side filtering).
  const [query, setQuery] = useState('');
  // Structured filter pushed by the agent over the UI bus (contract 3).
  const [assistantFilter, setAssistantFilter] = useState<LibraryFilter | null>(null);
  // Star band filter (rating contract 1): "5 stars" keeps scores 4.6..5.0.
  const [starBucket, setStarBucket] = useState<number | null>(null);
  const [starBounds, setStarBounds] = useState<ScoreBounds | null>(null);
  const toast = useRef<Toast>(null);

  const existingVolumeIds = useMemo(
    () => new Set(books.map((b) => b.google_volume_id).filter((v): v is string => v != null)),
    [books],
  );

  // Agent UI bus: apply a filter, open a book, or clear the filter.
  useEffect(() => {
    const onBus = (e: Event) => {
      const detail = parseUiBusEvent((e as CustomEvent).detail);
      if (!detail) {
        return;
      }
      if (detail.action === 'filter_library') {
        const { action: _action, ...filter } = detail;
        setAssistantFilter(isEmptyFilter(filter) ? null : filter);
      } else if (detail.action === 'clear_filter') {
        setAssistantFilter(null);
      } else if (detail.action === 'open_book') {
        setSelected(books.find((b) => b.id === detail.book_id) ?? null);
      }
    };
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    return () => window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
  }, [books]);

  // The assistant filter is applied first, then the free-text box narrows further.
  const visibleBooks = useMemo(() => {
    const afterAssistant = applyFilter(books, assistantFilter);
    const afterQuery = query.trim() ? applyFilter(afterAssistant, { query }) : afterAssistant;
    return starBounds ? filterByScore(afterQuery, starBounds) : afterQuery;
  }, [books, assistantFilter, query, starBounds]);

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

  const openEdit = (id: number) => setFormTarget({ mode: 'edit', bookId: id });

  const handleSaved = (book: Book) => {
    const creating = formTarget?.mode === 'create';
    upsert(book);
    // Keep an open detail dialog in sync with the saved book.
    setSelected((prev) => (prev && prev.id === book.id ? book : prev));
    setFormTarget(null);
    toast.current?.show({
      severity: 'success',
      summary: creating ? 'Added' : 'Saved',
      detail: book.title,
    });
  };

  const total = books.length;
  const shown = visibleBooks.length;
  const filtered = !!query.trim() || assistantFilter != null || starBounds != null;
  const countLabel = loading
    ? 'Loading…'
    : filtered
      ? `${shown} of ${total} book${total === 1 ? '' : 's'}`
      : `${total} book${total === 1 ? '' : 's'}`;

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="library-toolbar">
        <div className="library-toolbar-left">
          <Button label="Add book" icon="pi pi-plus" onClick={() => setSearchOpen(true)} />
          <Button
            label="Add manually"
            icon="pi pi-pencil"
            outlined
            onClick={() => setFormTarget({ mode: 'create' })}
          />
          <span className="library-count">{countLabel}</span>
        </div>

        <div className="library-toolbar-right">
          <StarFilter
            value={starBucket}
            onChange={(stars, bounds) => {
              setStarBucket(stars);
              setStarBounds(bounds);
            }}
          />
          <span className="p-input-icon-left library-search">
            <i className="pi pi-search" />
            <InputText
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, author or series…"
              aria-label="Search library"
            />
            {query && (
              <i
                className="pi pi-times library-search-clear"
                role="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              />
            )}
          </span>
        </div>
      </div>

      {assistantFilter && (
        <div className="library-filter-chip">
          <Chip
            label={`Filtered by assistant · ${describeFilter(assistantFilter)}`}
            icon="pi pi-sparkles"
            removable
            onRemove={() => {
              setAssistantFilter(null);
              return true;
            }}
          />
        </div>
      )}

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      {!loading && shown === 0 && total > 0 ? (
        <div className="empty-state">
          <i className="pi pi-filter-slash" style={{ fontSize: '2.5rem' }} />
          <p>No books match the current filter.</p>
        </div>
      ) : (
        <BookGrid books={visibleBooks} loading={loading} onOpen={setSelected} />
      )}

      <BookDetailDialog
        book={selected}
        onHide={() => setSelected(null)}
        onStatus={handleStatus}
        onStars={handleStars}
        onDelete={handleDelete}
        onEdit={openEdit}
      />

      <SearchDialog
        visible={searchOpen}
        onHide={() => setSearchOpen(false)}
        onAdd={handleAdd}
        existingVolumeIds={existingVolumeIds}
        onAddManually={(prefill) => setFormTarget({ mode: 'create', initial: prefill })}
      />

      {formTarget && (
        <BookFormDialog
          visible
          mode={formTarget.mode}
          bookId={formTarget.bookId}
          initial={formTarget.initial}
          onHide={() => setFormTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
