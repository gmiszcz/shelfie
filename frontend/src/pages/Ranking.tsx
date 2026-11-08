import { Button } from 'primereact/button';
import { Column } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { Dropdown } from 'primereact/dropdown';
import { InputSwitch } from 'primereact/inputswitch';
import { ProgressBar } from 'primereact/progressbar';
import { Skeleton } from 'primereact/skeleton';
import { Toast } from 'primereact/toast';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import './Ranking.css';
import { ComparePair } from '../components/ComparePair';
import { HalfStarRating } from '../components/HalfStarRating';
import { formatAuthors } from '../format';
import { useAgentAnchor } from '../agent-ui';
import {
  bandLabel,
  confidenceLabel,
  confidenceOf,
  defaultGroup,
  filterBySearch,
  formatScore,
  groupOptions,
  newSessionId,
  rankBooks,
  shelvesOf,
} from '../ranking';
import { usePairQueue } from '../hooks/usePairQueue';
import { useBooksQuery } from '../queries';
import { api } from '../services/api';
import type { Book, Winner } from '../types';
import { BookCover, SearchInput } from '../ui';

const ALL_SHELVES = '__all__';

/** A sentinel Dropdown value for the "uncategorised" group (Dropdown cannot use null as a value). */
const NO_GROUP = '__none__';
const toGroupValue = (g: string | null): string => (g == null ? NO_GROUP : g);
const fromGroupValue = (v: string): string | null => (v === NO_GROUP ? null : v);

export function Ranking() {
  // The book list comes from the shared, persisted cache (same key as the Library), so
  // switching Library ↔ Ranking does NOT refetch while the data is fresh.
  const booksQuery = useBooksQuery();
  const books = useMemo(() => booksQuery.data ?? [], [booksQuery.data]);
  const booksLoading = booksQuery.isPending;
  const error = booksQuery.error ? booksQuery.error.message : null;

  // Local loading flag that also covers the first pair load.
  const [pairInit, setPairInit] = useState(true);
  const loading = booksLoading || pairInit;

  // Compare state.
  const [focus, setFocus] = useState<number | null>(null);
  const [comparedThisVisit, setComparedThisVisit] = useState(0);
  const [recomputing, setRecomputing] = useState(false);

  // Category (group) the comparison pairs are drawn from. null means uncategorised; undefined
  // means "not initialised yet" so we can seed it from the data on first load.
  const [category, setCategory] = useState<string | null | undefined>(undefined);

  // Table filters.
  const [shelf, setShelf] = useState<string>(ALL_SHELVES);
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  // Phone list: how many rows are shown (grows by 20 with "Show more").
  const [mobileLimit, setMobileLimit] = useState(20);
  const [search, setSearch] = useState('');

  const sessionId = useRef<string>(newSessionId());
  const toast = useRef<Toast>(null);
  // Keep the latest category in a ref so the UI-bus listener (bound once) can read it.
  const categoryRef = useRef<string | null | undefined>(undefined);
  categoryRef.current = category;

  // Refresh the cached book list (scores change after comparisons / recompute). Returns the
  // fresh rows so the initial-category seed can read them.
  const { refetch: refetchBooks } = booksQuery;
  const loadBooks = useCallback(async () => {
    const result = await refetchBooks();
    return result.data ?? [];
  }, [refetchBooks]);

  // Refresh the table's scores after comparisons, debounced so quick choices batch into one load.
  const reloadTimer = useRef<number | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) {
      window.clearTimeout(reloadTimer.current);
    }
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void loadBooks();
    }, 1500);
  }, [loadBooks]);
  useEffect(
    () => () => {
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
      }
    },
    [],
  );

  // Three pairs are kept ready: a choice shows the next one instantly while the comparison is
  // saved and the queue is refilled in the background.
  const pairs = usePairQueue({
    size: 3,
    sessionId: sessionId.current,
    onCompared: scheduleReload,
    onError: (message) => toast.current?.show({ severity: 'error', summary: 'Error', detail: message }),
  });
  const { reset: resetPairs } = pairs;
  const pair = pairs.current;
  const pairLoading = pairs.loading;
  const loadPair = useCallback(
    (focusId: number | null, group: string | null | undefined) => resetPairs(focusId, group ?? null),
    [resetPairs],
  );

  // Seed the compare category from the (cached) book list the first time it is available,
  // then load the first pair. Runs once per data arrival; `category === undefined` means
  // "not seeded yet". This replaces the old fetch-on-mount now that the list is cached.
  // NOTE: no "active" cleanup flag here. With the persisted cache the list is available at
  // once and the background refetch then changes `books`; a cleanup that cancelled the
  // seed (or React StrictMode's double effect) left `pairInit` true forever, so Ranking
  // hung on "Loading…". `seeded` makes this run exactly once; finishing is unconditional.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || booksQuery.isPending) {
      return;
    }
    seeded.current = true;
    // Default category = the one with the most rated books.
    const initial = defaultGroup(books);
    setCategory(initial);
    void loadPair(null, initial).finally(() => setPairInit(false));
  }, [booksQuery.isPending, books, loadPair]);

  const ratedBooks = useMemo(() => books.filter((b) => b.stars != null), [books]);

  const handleChoose = (winner: Winner) => {
    if (!pair) {
      return;
    }
    setComparedThisVisit((n) => n + 1);
    pairs.choose(winner);
  };

  const handleFocusChange = async (value: number | null) => {
    setFocus(value);
    await loadPair(value, category);
  };

  const handleCategoryChange = async (value: string) => {
    const group = fromGroupValue(value);
    setCategory(group);
    // Changing the category invalidates any book-level focus from the previous category.
    setFocus(null);
    await loadPair(null, group);
  };

  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      const result = await api.recomputeRatings();
      await Promise.all([loadBooks(), loadPair(focus, category)]);
      toast.current?.show({
        severity: 'success',
        summary: 'Scores recalculated',
        detail: `${result.rated_books} rated book${result.rated_books === 1 ? '' : 's'}, ${result.comparisons} comparison${result.comparisons === 1 ? '' : 's'}`,
      });
    } catch (err) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: err instanceof Error ? err.message : 'Could not recalculate scores',
      });
    } finally {
      setRecomputing(false);
    }
  };

  // --- agent anchors: ranking search, category, focus ------------------------------
  // Read live via refs/closures so the registered anchors always act on current state.
  useAgentAnchor({
    id: 'ranking.search',
    kind: 'search',
    label: 'Ranking search',
    description: 'Free-text search over the ranking table (title, author, series).',
    tab: 'ranking',
    getState: () => search,
    set: (v) => setSearch(typeof v === 'string' ? v : String(v ?? '')),
  });

  useAgentAnchor({
    id: 'ranking.category',
    kind: 'select',
    label: 'Ranking category',
    description: 'The category the comparison pairs are drawn from.',
    tab: 'ranking',
    getState: () => toGroupValue(categoryRef.current ?? null),
    options: () => categoryOptions,
    set: (v) => {
      void handleCategoryChange(String(v));
    },
  });

  useAgentAnchor({
    id: 'ranking.focus',
    kind: 'select',
    label: 'Ranking focus book',
    description: 'Focus the next comparisons on one book, or "" for the most informative pair.',
    tab: 'ranking',
    getState: () => (focus == null ? '' : String(focus)),
    options: () =>
      focusOptions.map((o) => ({
        value: o.value == null ? '' : String(o.value),
        label: o.label,
      })),
    set: (v) => {
      const id = v == null || v === '' ? null : Number(v);
      void handleFocusChange(Number.isNaN(id as number) ? null : id);
    },
  });

  const shelfOptions = useMemo(
    () => [
      { value: ALL_SHELVES, label: 'All shelves' },
      ...shelvesOf(books).map((s) => ({ value: s, label: s })),
    ],
    [books],
  );

  const categoryOptions = useMemo(
    () =>
      groupOptions(books).map((g) => ({
        value: toGroupValue(g.value),
        label: `${g.label} (${g.count})`,
      })),
    [books],
  );

  // Books eligible for focus are those in the selected category (pairs stay within it).
  const focusCandidates = useMemo(() => {
    if (category === undefined) {
      return ratedBooks;
    }
    return ratedBooks.filter((b) => {
      const g = b.shelves[0] ?? b.categories[0] ?? null;
      return g === category;
    });
  }, [ratedBooks, category]);

  const focusOptions = useMemo(
    () => [
      { value: null, label: 'No focus (most informative pair)' },
      ...focusCandidates
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((b) => ({ value: b.id, label: b.title })),
    ],
    [focusCandidates],
  );

  const ranked = useMemo(() => {
    const base = rankBooks(books, {
      shelf: shelf === ALL_SHELVES ? undefined : shelf,
      onlyTopRated,
    });
    return filterBySearch(base, search);
  }, [books, shelf, onlyTopRated, search]);

  // --- column bodies -------------------------------------------------------------------
  const rankBody = (_row: Book, { rowIndex }: { rowIndex: number }) => (
    <span className="rank-number">#{rowIndex + 1}</span>
  );

  const coverBody = (row: Book) => (
    <BookCover src={row.cover_url} title={row.title} size="thumb" />
  );

  const titleBody = (row: Book) => (
    <div className="rank-title">
      <span className="t" title={row.title}>
        {row.title}
      </span>
      <span className="a">{formatAuthors(row.authors)}</span>
    </div>
  );

  const starsBody = (row: Book) =>
    row.stars != null ? (
      <HalfStarRating value={row.stars} onChange={() => {}} readOnly ariaLabel={`${row.stars} stars`} />
    ) : (
      '—'
    );

  const scoreBody = (row: Book) => <span className="rank-score">{formatScore(row)}</span>;

  const bandBody = (row: Book) => <span className="rank-band">{bandLabel(row)}</span>;

  const confidenceBody = (row: Book) => {
    if (row.stars == null) {
      return '—';
    }
    const pct = Math.round(confidenceOf(row) * 100);
    return (
      <div className="rank-confidence" title={`${row.comparison_count} comparison(s)`}>
        <span className="rank-confidence-label">{confidenceLabel(row)}</span>
        <ProgressBar
          value={pct}
          showValue={false}
          style={{ height: '6px' }}
          aria-label={`Confidence ${pct}%`}
        />
      </div>
    );
  };

  const uncertaintyBody = (row: Book) =>
    row.rating_uncertainty != null ? `± ${row.rating_uncertainty.toFixed(2)}` : '—';

  const focusBody = (row: Book) => {
    const inCategory =
      category === undefined || (row.shelves[0] ?? row.categories[0] ?? null) === category;
    const isFocused = focus === row.id;
    return (
      <Button
        icon={isFocused ? 'pi pi-star-fill' : 'pi pi-crosshairs'}
        rounded
        text
        size="small"
        aria-label={isFocused ? `Stop focusing ${row.title}` : `Focus comparisons on ${row.title}`}
        title={
          inCategory
            ? isFocused
              ? 'Focused — click to clear'
              : 'Focus the next comparisons on this book'
            : 'Switch to this book’s category to focus it'
        }
        disabled={!inCategory}
        onClick={() => void handleFocusChange(isFocused ? null : row.id)}
      />
    );
  };

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="rank-page">
        <div className="rank-toolbar">
          <Button
            label="Recalculate scores"
            icon="pi pi-refresh"
            onClick={() => void handleRecompute()}
            loading={recomputing}
          />
          <span className="rank-toolbar-count">
            {loading ? 'Loading…' : `${ratedBooks.length} rated book${ratedBooks.length === 1 ? '' : 's'}`}
          </span>
        </div>

        {error && <p className="rank-error">{error}</p>}

        {/* Collapsed by default so the compare pair sits near the top (phones). */}
        <details className="rank-infobox" role="note">
          <summary className="rank-infobox-summary">
            <i className="pi pi-info-circle" aria-hidden="true" />
            <strong>How the score works</strong>
          </summary>
          <div className="rank-infobox-body">
            Your star rating sets a <em>band</em>: a 5★ book
            lives in <code>4.6–5.0</code>, a 4.5★ book in <code>4.1–4.5</code>, and so on. Each
            comparison nudges the book you did <em>not</em> pick down by one 0.1 step within its band
            (never more), so the order by stars is always kept and refinement is gradual. Comparisons
            are always between two books in the <em>same category</em>.
          </div>
        </details>

      {/* --- Compare section --------------------------------------------------------- */}
      <section className="rank-section">
        <div className="rank-section-head">
          <h2>Refine the ranking</h2>
          <div className="rank-section-controls">
            <Dropdown
              value={toGroupValue(category ?? null)}
              options={categoryOptions}
              onChange={(e) => void handleCategoryChange(e.value)}
              className="rank-category"
              aria-label="Category to compare within"
              placeholder="Category"
              disabled={loading || categoryOptions.length === 0}
            />
            <Dropdown
              value={focus}
              options={focusOptions}
              onChange={(e) => void handleFocusChange(e.value)}
              filter
              placeholder="Focus on a book"
              className="rank-focus"
              disabled={loading || focusCandidates.length < 2}
            />
            <span className="rank-counter">
              {comparedThisVisit} comparison{comparedThisVisit === 1 ? '' : 's'} this visit
            </span>
          </div>
        </div>

        <div className="rank-compare-panel">
          {loading || pairLoading ? (
            <div className="rank-compare-skeleton">
              <Skeleton width="100%" height="360px" />
            </div>
          ) : ratedBooks.length < 2 ? (
            <div className="empty-state">
              <i className="pi pi-sort-amount-down" style={{ fontSize: '2.5rem' }} />
              <p>Rate at least two books with stars to start comparing them.</p>
            </div>
          ) : pair ? (
            <ComparePair
            key={`${pair.left.id}-${pair.right.id}`}
            left={pair.left}
            right={pair.right}
            sending={false}
            onChoose={handleChoose}
          />
          ) : (
            <div className="empty-state">
              <p>
                No more pairs to compare
                {focus != null ? ' for this book' : ' in this category'}. Pick another category or
                book, or the ranking is as refined as it gets for now.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* --- Ranking table ----------------------------------------------------------- */}
      <section className="rank-section">
        <div className="rank-section-head">
          <h2>Ranking</h2>
          <div className="rank-section-controls">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search title, author, series"
              ariaLabel="Search the ranking"
              fullWidth={false}
              className="rank-search"
            />
            <Dropdown
              value={shelf}
              options={shelfOptions}
              onChange={(e) => setShelf(e.value)}
              className="rank-shelf"
              aria-label="Filter by shelf"
            />
            <label className="rank-toggle">
              <InputSwitch checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.value)} />
              Only 5★
            </label>
          </div>
        </div>

        <div className="rank-table-panel" data-agent-anchor="ranking.list">
          {/* Phones: one compact row per book (rank, small cover, title/author, score and
              stars, focus) — no sideways scrolling. The full table is for wider screens. */}
          <ol className="rank-mobile-list" aria-label="Ranking">
            {ranked.slice(0, mobileLimit).map((row, i) => (
              <li key={row.id} className="rank-mobile-row">
                <span className="rank-number">#{i + 1}</span>
                <BookCover src={row.cover_url} title={row.title} size="thumb" />
                <div className="rank-mobile-main">
                  <span className="t" title={row.title}>
                    {row.title}
                  </span>
                  <span className="a">{formatAuthors(row.authors)}</span>
                  {row.stars != null && (
                    <span className="rank-mobile-stars">
                      <HalfStarRating
                        value={row.stars}
                        onChange={() => {}}
                        readOnly
                        ariaLabel={`${row.stars} stars`}
                      />
                    </span>
                  )}
                </div>
                <span className="rank-score">{formatScore(row)}</span>
                {focusBody(row)}
              </li>
            ))}
            {!loading && ranked.length === 0 && (
              <li className="rank-mobile-empty">No rated books match these filters.</li>
            )}
          </ol>
          {ranked.length > mobileLimit && (
            <Button
              className="rank-mobile-more"
              label={`Show more (${ranked.length - mobileLimit})`}
              text
              onClick={() => setMobileLimit((n) => n + 20)}
            />
          )}
          <DataTable
            value={ranked}
            loading={loading}
            paginator
            rows={15}
            dataKey="id"
            emptyMessage="No rated books match these filters."
            className="rank-table"
          >
            <Column header="#" body={rankBody} style={{ width: '4rem' }} />
            <Column header="Cover" body={coverBody} style={{ width: '4rem' }} />
            <Column header="Title" body={titleBody} />
            <Column header="Stars" body={starsBody} style={{ width: '10rem' }} />
            <Column header="Score" body={scoreBody} style={{ width: '6rem' }} />
            <Column header="Band" body={bandBody} style={{ width: '7rem' }} />
            <Column header="Comparisons" field="comparison_count" style={{ width: '8rem' }} />
            <Column header="Confidence" body={confidenceBody} style={{ width: '9rem' }} />
            <Column header="±" body={uncertaintyBody} style={{ width: '6rem' }} />
            <Column header="Focus" body={focusBody} style={{ width: '5rem' }} />
          </DataTable>
        </div>
      </section>
      </div>
    </>
  );
}
