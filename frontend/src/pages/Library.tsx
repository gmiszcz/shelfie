import { Button } from 'primereact/button';
import { Chip } from 'primereact/chip';
import { InputText } from 'primereact/inputtext';
import { Toast } from 'primereact/toast';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { BookFormDialog } from '../components/BookFormDialog';
import { BookGrid } from '../components/BookGrid';
import { SearchDialog } from '../components/SearchDialog';
import { StarFilter, boundsForStarBucket } from '../components/StarFilter';
import type { ScoreBounds, StarBucket } from '../components/StarFilter';
import { useLibrary } from '../hooks/useLibrary';
import { useSettings } from '../settings/SettingsContext';
import { filterByScore } from '../ranking';
import { applyFilter, describeFilter, isEmptyFilter } from '../settings/libraryFilter';
import type { LibraryFilter } from '../settings/libraryFilter';
import { UI_BUS_EVENT, dispatchUiAck, parseUiBusEvent } from '../settings/uiBus';
import type { StarValue } from '../settings/uiBus';
import type { Book, BookInput, ReadingStatus, VolumeSearchResult } from '../types';

interface FormTarget {
  mode: 'create' | 'edit';
  bookId?: number;
  initial?: Partial<BookInput>;
}

export function Library() {
  const { books, loading, error, add, update, remove, upsert } = useLibrary();
  const { settings } = useSettings();
  const [selected, setSelected] = useState<Book | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialQuery, setSearchInitialQuery] = useState<string | undefined>(undefined);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  // Free-text search box (client-side filtering).
  const [query, setQuery] = useState('');
  // Structured filter pushed by the agent over the UI bus (contract 3).
  const [assistantFilter, setAssistantFilter] = useState<LibraryFilter | null>(null);
  // Whole-star band filter (wave-3): "5" keeps scores 4.6..5.0, etc.
  const [starBucket, setStarBucket] = useState<StarBucket | null>(null);
  const [starBounds, setStarBounds] = useState<ScoreBounds | null>(null);
  const toast = useRef<Toast>(null);

  const existingVolumeIds = useMemo(
    () => new Set(books.map((b) => b.google_volume_id).filter((v): v is string => v != null)),
    [books],
  );

  const applyStarValue = (stars: StarValue) => {
    if (stars == null) {
      setStarBucket(null);
      setStarBounds(null);
    } else {
      setStarBucket(stars);
      setStarBounds(boundsForStarBucket(stars));
    }
  };

  // Agent UI bus v2: filters, search box, star filter, add-book, dialogs.
  useEffect(() => {
    const onBus = (e: Event) => {
      const detail = parseUiBusEvent((e as CustomEvent).detail);
      if (!detail) {
        return;
      }
      let ok = true;
      let info: string | undefined;
      switch (detail.action) {
        case 'filter_library': {
          const { action: _action, ...filter } = detail;
          setAssistantFilter(isEmptyFilter(filter) ? null : filter);
          break;
        }
        case 'clear_filter':
          setAssistantFilter(null);
          break;
        case 'open_book': {
          const book = books.find((b) => b.id === detail.book_id) ?? null;
          setSelected(book);
          ok = book != null;
          info = ok ? undefined : `no book #${detail.book_id}`;
          break;
        }
        case 'set_search':
          setQuery(detail.query);
          break;
        case 'set_star_filter':
          applyStarValue(detail.stars);
          break;
        case 'open_add_book':
          if (detail.mode === 'manual') {
            setFormTarget({ mode: 'create', initial: detail.prefill });
          } else {
            setSearchInitialQuery(detail.query ?? '');
            setSearchOpen(true);
          }
          break;
        case 'close_dialogs':
          setSelected(null);
          setSearchOpen(false);
          setFormTarget(null);
          break;
        default:
          // Actions handled elsewhere (App): navigate, open_settings,
          // toggle_theme, set_setting, ranking. Ignore here.
          return;
      }
      dispatchUiAck({ action: detail.action, ok, info });
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

  // Keep the read-only state snapshot up to date for the agent (ui-agent reads it).
  useEffect(() => {
    const openDialog = formTarget
      ? 'form'
      : searchOpen
        ? 'search'
        : selected
          ? 'detail'
          : 'none';
    window.__shelfieUiState = {
      ...(window.__shelfieUiState ?? {
        tab: 'library',
        search: '',
        starFilter: null,
        assistantFilter: null,
        settings: null,
        visibleBookIds: [],
        openDialog: 'none',
      }),
      search: query,
      starFilter: starBucket,
      assistantFilter,
      settings,
      visibleBookIds: visibleBooks.map((b) => b.id),
      openDialog,
    };
  }, [query, starBucket, assistantFilter, settings, visibleBooks, formTarget, searchOpen, selected]);

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
          <Button
            label="Add book"
            icon="pi pi-plus"
            onClick={() => {
              setSearchInitialQuery(undefined);
              setSearchOpen(true);
            }}
          />
          <Button
            label="Add manually"
            icon="pi pi-pencil"
            outlined
            onClick={() => setFormTarget({ mode: 'create' })}
          />
          <span className="library-count">{countLabel}</span>
        </div>

        <div className="library-toolbar-right">
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

          <StarFilter
            value={starBucket}
            onChange={(stars, bounds) => {
              setStarBucket(stars);
              setStarBounds(bounds);
            }}
          />
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
        initialQuery={searchInitialQuery}
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
