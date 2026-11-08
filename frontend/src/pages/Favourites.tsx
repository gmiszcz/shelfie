import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { BookGrid } from '../components/BookGrid';
import { StarFilter } from '../components/StarFilter';
import type { ScoreBounds, StarBucket } from '../components/StarFilter';
import { useLibrary } from '../hooks/useLibrary';
import { useFavourites } from '../queries';
import { filterByScore } from '../ranking';
import { applyFilter } from '../settings/libraryFilter';
import { useAgentAnchor } from '../agent-ui';
import { SearchInput } from '../ui';
import type { Book, ReadingStatus } from '../types';

import './Favourites.css';

/**
 * The Favourites tab: every book flagged with the heart, in the same grid as the
 * Library, with the shared SearchInput and the star filter. The heart on each card (and
 * in the detail dialog) un-favourites, which removes the book from this list.
 */
export function Favourites() {
  // Favourites are derived from the one cached book list (useFavourites), so this tab
  // shares the Library's cache and needs no extra request. Mutations go through useLibrary,
  // which writes the same cache.
  const { favourites, isPending: loading, error: favError } = useFavourites();
  const { update, remove } = useLibrary();
  const error = favError ? favError.message : null;
  const [selected, setSelected] = useState<Book | null>(null);
  const [query, setQuery] = useState('');
  const [starBucket, setStarBucket] = useState<StarBucket | null>(null);
  const [starBounds, setStarBounds] = useState<ScoreBounds | null>(null);
  const toast = useRef<Toast>(null);

  const notifyError = (message: string) =>
    toast.current?.show({ severity: 'error', summary: 'Error', detail: message });

  const visibleBooks = useMemo(() => {
    const afterQuery = query.trim() ? applyFilter(favourites, { query }) : favourites;
    return starBounds ? filterByScore(afterQuery, starBounds) : afterQuery;
  }, [favourites, query, starBounds]);

  const handleFavourite = async (id: number, next: boolean) => {
    try {
      await update(id, { favourite: next });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, favourite: next } : prev));
      if (!next) {
        toast.current?.show({ severity: 'info', summary: 'Removed from favourites' });
      }
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update favourite');
    }
  };

  // --- UI-agent anchors (universal registry). --------------------------------------------
  useAgentAnchor({
    id: 'favourites.search',
    kind: 'search',
    label: 'Favourites search',
    description: 'Filters favourite books by title, author or series.',
    tab: 'favourites',
    getState: () => query,
    set: (v) => setQuery(typeof v === 'string' ? v : String(v ?? '')),
  });

  useAgentAnchor({
    id: 'favourites.books',
    kind: 'list',
    label: 'Favourite books',
    description:
      'Favourite books currently shown. Actions: "open" with args { id }, "unfavourite" with { id }. ' +
      'To ADD a favourite, use the library: open the book and set it as favourite, or ask the library agent.',
    tab: 'favourites',
    actions: ['open', 'unfavourite'],
    getState: () => visibleBooks.map((b) => ({ id: b.id, title: b.title })),
    items: () => visibleBooks.map((b) => ({ id: b.id, title: b.title })),
    invoke: async (action, args) => {
      const id = Number(args?.id);
      const book = favourites.find((b) => b.id === id);
      if (!book) {
        throw new Error(`no favourite book #${args?.id}`);
      }
      if (action === 'open') {
        setSelected(book);
      } else if (action === 'unfavourite') {
        await handleFavourite(id, false);
      } else {
        throw new Error('use "open" or "unfavourite"');
      }
    },
  });

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

  const total = favourites.length;
  const shown = visibleBooks.length;
  const filtered = !!query.trim() || starBounds != null;
  const countLabel = loading
    ? 'Loading…'
    : filtered
      ? `${shown} of ${total} favourite${total === 1 ? '' : 's'}`
      : `${total} favourite${total === 1 ? '' : 's'}`;

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="favourites-toolbar">
        <div className="favourites-toolbar-head">
          <h2 className="favourites-title">
            <i className="pi pi-heart-fill" aria-hidden="true" /> Favourites
          </h2>
          <span className="favourites-count">{countLabel}</span>
        </div>

        <div className="favourites-toolbar-search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search favourites by title, author or series…"
            ariaLabel="Search favourites"
          />
        </div>

        <div className="favourites-toolbar-filter">
          <StarFilter
            value={starBucket}
            onChange={(stars, bounds) => {
              setStarBucket(stars);
              setStarBounds(bounds);
            }}
          />
        </div>
      </div>

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      {!loading && total === 0 ? (
        <div className="empty-state">
          <i className="pi pi-heart" style={{ fontSize: '2.5rem' }} />
          <p>No favourites yet. Tap the heart on a book to add it here.</p>
        </div>
      ) : !loading && shown === 0 ? (
        <div className="empty-state">
          <i className="pi pi-filter-slash" style={{ fontSize: '2.5rem' }} />
          <p>No favourites match the current filter.</p>
        </div>
      ) : (
        <BookGrid
          anchor="favourites.books"
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
        onEdit={() => undefined}
        onFavourite={handleFavourite}
      />
    </>
  );
}
