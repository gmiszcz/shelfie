import { Button } from 'primereact/button';
import { Chip } from 'primereact/chip';
import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { useAgentAnchor } from '../agent-ui';
import { BookDetailDialog } from '../components/BookDetailDialog';
import { BookFormDialog } from '../components/BookFormDialog';
import { BookGrid } from '../components/BookGrid';
import { SearchDialog } from '../components/SearchDialog';
import { StarFilter, boundsForStarBucket } from '../components/StarFilter';
import type { ScoreBounds, StarBucket } from '../components/StarFilter';
import { SearchInput } from '../ui';
import { useLibrary } from '../hooks/useLibrary';
import { filterByScore } from '../ranking';
import { applyFilter, describeFilter, isEmptyFilter, resolveFacet } from '../settings/libraryFilter';
import {
  authorsOf,
  finishedYears,
  publishedYears,
  seriesOf,
  shelvesOf,
  startedYears,
  STATUS_VALUES,
  tagsOf,
} from '../settings/libraryFilter';
import type { LibraryFilter } from '../settings/libraryFilter';
import type { StarValue } from '../settings/uiBus';
import type { Book, BookInput, ReadingStatus, VolumeSearchResult } from '../types';

interface FormTarget {
  mode: 'create' | 'edit';
  bookId?: number;
  initial?: Partial<BookInput>;
}

/** Facets the agent can apply to the assistant filter (anchor `library.filter`). */
type FilterArgs = LibraryFilter;

export function Library() {
  // Latest favourite handler for the agent anchor (the handler is defined further down).
  const handleFavouriteRef = useRef<(id: number, next: boolean) => Promise<void>>(async () => {});
  const { books, loading, error, add, update, remove, upsert } = useLibrary();
  const [selected, setSelected] = useState<Book | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialQuery, setSearchInitialQuery] = useState<string | undefined>(undefined);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  // Free-text search box (client-side filtering).
  const [query, setQuery] = useState('');
  // Structured filter pushed by the agent (anchor `library.filter`).
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

  // The assistant filter is applied first, then the free-text box narrows further.
  const visibleBooks = useMemo(() => {
    const afterAssistant = applyFilter(books, assistantFilter);
    const afterQuery = query.trim() ? applyFilter(afterAssistant, { query }) : afterAssistant;
    return starBounds ? filterByScore(afterQuery, starBounds) : afterQuery;
  }, [books, assistantFilter, query, starBounds]);

  // --- agent anchors (the only agent-facing code in this page) -----------------------
  useAgentAnchor({
    id: 'library.search',
    kind: 'search',
    label: 'Library search',
    description: 'Free-text search box filtering the library by title, author or series.',
    tab: 'library',
    getState: () => query,
    set: (v) => setQuery(typeof v === 'string' ? v : String(v ?? '')),
  });

  useAgentAnchor({
    id: 'library.starFilter',
    kind: 'select',
    label: 'Star rating filter',
    description: 'Whole-star library filter. 5 shows 4.6–5.0, 4 shows 3.6–4.5, etc. Empty clears it.',
    tab: 'library',
    getState: () => (starBucket == null ? '' : String(starBucket)),
    options: () => [
      { value: '', label: 'Any rating' },
      { value: '1', label: '1 star' },
      { value: '2', label: '2 stars' },
      { value: '3', label: '3 stars' },
      { value: '4', label: '4 stars' },
      { value: '5', label: '5 stars' },
    ],
    set: (v) => {
      const n = v == null || v === '' ? null : Number(v);
      applyStarValue(n != null && n >= 1 && n <= 5 ? (n as StarValue) : null);
    },
  });

  useAgentAnchor({
    id: 'library.filter',
    kind: 'button',
    label: 'Assistant library filter',
    description:
      'Filter the grid by one or more STRUCTURED facets. Invoke with action "apply" and args ' +
      '{ query?, series?, author?, shelf?, tag?, status?, min_stars?, finished_year?, ' +
      'started_year?, published_year?, finished_from?, finished_to?, book_ids? }. ' +
      'series/author/shelf/tag accept a plain HUMAN NAME — it is matched to the real value ' +
      'itself (case, diacritics and inflection tolerant), so you do NOT need find_books for a ' +
      'normal filter. Use finished_year for "read in <year>". action "clear" removes the filter.',
    tab: 'library',
    actions: ['apply', 'clear'],
    getState: () => assistantFilter,
    invoke: (action, args) => {
      if (action === 'clear') {
        setAssistantFilter(null);
        return;
      }
      const f = (args ?? {}) as FilterArgs;
      const filter: LibraryFilter = {};
      // query/status pass through; series/author/shelf/tag are human names the agent
      // typed, so resolve each against the actual values in the library (case /
      // diacritics / inflection tolerant) — no find_books round-trip needed.
      for (const key of ['query', 'status'] as const) {
        const val = f[key];
        if (typeof val === 'string' && val.trim()) {
          filter[key] = val.trim();
        }
      }
      const facetCandidates: Record<'series' | 'author' | 'shelf' | 'tag', string[]> = {
        series: seriesOf(books),
        author: authorsOf(books),
        shelf: shelvesOf(books),
        tag: tagsOf(books),
      };
      for (const key of ['series', 'author', 'shelf', 'tag'] as const) {
        const val = f[key];
        if (typeof val === 'string' && val.trim()) {
          filter[key] = resolveFacet(val.trim(), facetCandidates[key]);
        }
      }
      for (const key of [
        'finished_from',
        'finished_to',
      ] as const) {
        const val = f[key];
        if (typeof val === 'string' && val.trim()) {
          filter[key] = val.trim();
        }
      }
      for (const key of ['finished_year', 'started_year', 'published_year'] as const) {
        const val = f[key];
        const n = typeof val === 'number' ? val : Number(val);
        if (!Number.isNaN(n) && n > 0) {
          filter[key] = n;
        }
      }
      if (typeof f.min_stars === 'number' && f.min_stars > 0) {
        filter.min_stars = f.min_stars;
      }
      if (Array.isArray(f.book_ids)) {
        const ids = f.book_ids.filter((n): n is number => typeof n === 'number');
        if (ids.length) {
          filter.book_ids = ids;
        }
      }
      setAssistantFilter(isEmptyFilter(filter) ? null : filter);
    },
  });

  // One structured facet of the assistant filter, exposed as a select anchor whose
  // options are DERIVED FROM THE DATA. Setting it merges that one facet into the
  // current filter (empty value clears just that facet). `mergeFacet` keeps the
  // other active facets intact so the agent can build a filter incrementally.
  const mergeFacet = (patch: LibraryFilter) =>
    setAssistantFilter((prev) => {
      const next = { ...(prev ?? {}), ...patch };
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') {
          delete (next as Record<string, unknown>)[k];
        }
      }
      return isEmptyFilter(next) ? null : next;
    });

  useAgentAnchor({
    id: 'library.finishedYear',
    kind: 'select',
    label: 'Finished-in-year filter',
    description: 'Show only books FINISHED in a given calendar year (finished_on). "" clears it.',
    tab: 'library',
    getState: () => (assistantFilter?.finished_year == null ? '' : String(assistantFilter.finished_year)),
    options: () => [
      { value: '', label: 'Any year' },
      ...finishedYears(books).map((y) => ({ value: String(y), label: String(y) })),
    ],
    set: (v) => mergeFacet({ finished_year: v ? Number(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.startedYear',
    kind: 'select',
    label: 'Started-in-year filter',
    description: 'Show only books STARTED in a given calendar year (started_on). "" clears it.',
    tab: 'library',
    getState: () => (assistantFilter?.started_year == null ? '' : String(assistantFilter.started_year)),
    options: () => [
      { value: '', label: 'Any year' },
      ...startedYears(books).map((y) => ({ value: String(y), label: String(y) })),
    ],
    set: (v) => mergeFacet({ started_year: v ? Number(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.publishedYear',
    kind: 'select',
    label: 'Published-in-year filter',
    description: 'Show only books PUBLISHED in a given year (published_date). "" clears it.',
    tab: 'library',
    getState: () => (assistantFilter?.published_year == null ? '' : String(assistantFilter.published_year)),
    options: () => [
      { value: '', label: 'Any year' },
      ...publishedYears(books).map((y) => ({ value: String(y), label: String(y) })),
    ],
    set: (v) => mergeFacet({ published_year: v ? Number(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.status',
    kind: 'select',
    label: 'Reading-status filter',
    description: 'Show only books with a given reading status. "" clears it.',
    tab: 'library',
    getState: () => assistantFilter?.status ?? '',
    options: () => [
      { value: '', label: 'Any status' },
      ...STATUS_VALUES.map((s) => ({ value: s, label: s })),
    ],
    set: (v) => mergeFacet({ status: v ? String(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.shelf',
    kind: 'select',
    label: 'Shelf filter',
    description: 'Show only books on a given shelf. "" clears it.',
    tab: 'library',
    getState: () => assistantFilter?.shelf ?? '',
    options: () => [
      { value: '', label: 'Any shelf' },
      ...shelvesOf(books).map((s) => ({ value: s, label: s })),
    ],
    set: (v) => mergeFacet({ shelf: v ? String(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.tag',
    kind: 'select',
    label: 'Tag filter',
    description: 'Show only books with a given tag. "" clears it.',
    tab: 'library',
    getState: () => assistantFilter?.tag ?? '',
    options: () => [
      { value: '', label: 'Any tag' },
      ...tagsOf(books).map((t) => ({ value: t, label: t })),
    ],
    set: (v) => mergeFacet({ tag: v ? String(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.series',
    kind: 'select',
    label: 'Series filter',
    description: 'Show only books in a given series. "" clears it.',
    tab: 'library',
    getState: () => assistantFilter?.series ?? '',
    options: () => [
      { value: '', label: 'Any series' },
      ...seriesOf(books).map((s) => ({ value: s, label: s })),
    ],
    set: (v) => mergeFacet({ series: v ? String(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.author',
    kind: 'select',
    label: 'Author filter',
    description: 'Show only books by a given author. "" clears it.',
    tab: 'library',
    getState: () => assistantFilter?.author ?? '',
    options: () => [
      { value: '', label: 'Any author' },
      ...authorsOf(books).map((a) => ({ value: a, label: a })),
    ],
    set: (v) => mergeFacet({ author: v ? String(v) : undefined }),
  });

  useAgentAnchor({
    id: 'library.books',
    kind: 'list',
    label: 'Visible books',
    description:
      'The books currently shown in the grid. Actions: "open" with args { id } opens one; ' +
      '"favourite" / "unfavourite" with { id } adds or removes it from Favourites.',
    tab: 'library',
    actions: ['open', 'favourite', 'unfavourite'],
    getState: () => visibleBooks.map((b) => ({ id: b.id, title: b.title, favourite: b.favourite })),
    items: () => visibleBooks.map((b) => ({ id: b.id, title: b.title })),
    invoke: async (action, args) => {
      const id = Number(args?.id);
      const book = books.find((b) => b.id === id) ?? null;
      if (!book) {
        throw new Error(`no book #${args?.id}`);
      }
      if (action === 'favourite' || action === 'unfavourite') {
        await handleFavouriteRef.current(id, action === 'favourite');
        return;
      }
      setSelected(book);
    },
  });

  useAgentAnchor({
    id: 'library.addBook',
    kind: 'button',
    label: 'Add a book',
    description:
      'Open the add-book flow. Invoke with action "search" (args { query? } — the Google-search ' +
      'dialog, optionally with a query typed) or action "manual" (args { prefill? } — the manual form).',
    tab: 'library',
    actions: ['search', 'manual'],
    invoke: (action, args) => {
      if (action === 'manual') {
        setFormTarget({ mode: 'create', initial: args?.prefill as Partial<BookInput> | undefined });
      } else {
        setSearchInitialQuery(typeof args?.query === 'string' ? args.query : '');
        setSearchOpen(true);
      }
    },
  });

  useAgentAnchor({
    id: 'library.dialogs',
    kind: 'dialog',
    label: 'Library dialogs',
    description: 'The open book-detail / add dialogs. Invoke with action "close" to close them all.',
    tab: 'library',
    actions: ['close'],
    getState: () => {
      if (formTarget) return 'form';
      if (searchOpen) return 'search';
      if (selected) return 'detail';
      return 'none';
    },
    invoke: (action) => {
      if (action === 'close') {
        setSelected(null);
        setSearchOpen(false);
        setFormTarget(null);
      }
    },
  });

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

  handleFavouriteRef.current = (id: number, next: boolean) => handleFavourite(id, next);
  const handleFavourite = async (id: number, next: boolean) => {
    try {
      await update(id, { favourite: next });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, favourite: next } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update favourite');
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
        <div className="library-toolbar-actions">
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

        <div className="library-toolbar-search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search title, author or series…"
            ariaLabel="Search library"
          />
        </div>

        <div className="library-toolbar-filter">
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
        <BookGrid
          books={visibleBooks}
          loading={loading}
          onOpen={setSelected}
          onToggleFavourite={(book, next) => handleFavourite(book.id, next)}
        />
      )}

      <BookDetailDialog
        book={selected}
        onHide={() => setSelected(null)}
        onStatus={handleStatus}
        onStars={handleStars}
        onDelete={handleDelete}
        onEdit={openEdit}
        onFavourite={handleFavourite}
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
