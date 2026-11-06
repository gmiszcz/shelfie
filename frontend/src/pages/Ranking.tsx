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
import {
  bandLabel,
  confidenceLabel,
  confidenceOf,
  formatScore,
  newSessionId,
  rankBooks,
  shelvesOf,
} from '../ranking';
import { api } from '../services/api';
import type { Book, RatingPair, Winner } from '../types';

const ALL_SHELVES = '__all__';

export function Ranking() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Compare state.
  const [pair, setPair] = useState<RatingPair | null>(null);
  const [pairLoading, setPairLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [comparedThisVisit, setComparedThisVisit] = useState(0);
  const [recomputing, setRecomputing] = useState(false);

  // Table filters.
  const [shelf, setShelf] = useState<string>(ALL_SHELVES);
  const [onlyTopRated, setOnlyTopRated] = useState(false);

  const sessionId = useRef<string>(newSessionId());
  const toast = useRef<Toast>(null);

  const loadBooks = useCallback(async () => {
    const data = await api.listBooks();
    setBooks(data);
    return data;
  }, []);

  const loadPair = useCallback(async (focusId: number | null) => {
    setPairLoading(true);
    try {
      const next = await api.nextPair(focusId ?? undefined);
      setPair(next);
    } catch (err) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: err instanceof Error ? err.message : 'Could not load the next pair',
      });
    } finally {
      setPairLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadBooks();
        if (active) {
          await loadPair(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Could not load books');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [loadBooks, loadPair]);

  const ratedBooks = useMemo(() => books.filter((b) => b.stars != null), [books]);

  const handleChoose = async (winner: Winner) => {
    if (!pair || sending) {
      return;
    }
    setSending(true);
    try {
      await api.compare(pair.left.id, pair.right.id, winner, sessionId.current);
      setComparedThisVisit((n) => n + 1);
      await Promise.all([loadBooks(), loadPair(focus)]);
    } catch (err) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: err instanceof Error ? err.message : 'Could not record the comparison',
      });
    } finally {
      setSending(false);
    }
  };

  const handleFocusChange = async (value: number | null) => {
    setFocus(value);
    await loadPair(value);
  };

  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      const result = await api.recomputeRatings();
      await Promise.all([loadBooks(), loadPair(focus)]);
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

  const shelfOptions = useMemo(
    () => [
      { value: ALL_SHELVES, label: 'All shelves' },
      ...shelvesOf(books).map((s) => ({ value: s, label: s })),
    ],
    [books],
  );

  const focusOptions = useMemo(
    () => [
      { value: null, label: 'No focus (most informative pair)' },
      ...ratedBooks
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((b) => ({ value: b.id, label: b.title })),
    ],
    [ratedBooks],
  );

  const ranked = useMemo(
    () =>
      rankBooks(books, {
        shelf: shelf === ALL_SHELVES ? undefined : shelf,
        onlyTopRated,
      }),
    [books, shelf, onlyTopRated],
  );

  // --- column bodies -------------------------------------------------------------------
  const rankBody = (_row: Book, { rowIndex }: { rowIndex: number }) => (
    <span className="rank-number">#{rowIndex + 1}</span>
  );

  const coverBody = (row: Book) => (
    <div className="rank-cover">
      {row.cover_url ? (
        <img src={row.cover_url} alt={`Cover of ${row.title}`} loading="lazy" />
      ) : (
        <i className="pi pi-book" />
      )}
    </div>
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

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="toolbar">
        <Button
          label="Recalculate scores"
          icon="pi pi-refresh"
          onClick={() => void handleRecompute()}
          loading={recomputing}
        />
        <span style={{ color: 'var(--app-text-muted)' }}>
          {loading ? 'Loading…' : `${ratedBooks.length} rated book${ratedBooks.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      <div className="rank-infobox" role="note">
        <i className="pi pi-info-circle" aria-hidden="true" />
        <div>
          <strong>How the score works.</strong> Your star rating sets a <em>band</em>: a 5★ book
          lives in <code>4.6–5.0</code>, a 4.5★ book in <code>4.1–4.5</code>, and so on. Comparisons
          only reorder books <em>within</em> a band and can nudge a book <em>down</em> from its star
          value, never up — so the order by stars is always kept and bands never overlap. The best
          book in a band stays exactly at its star value; a book with few comparisons stays near the
          top until enough evidence places it.
        </div>
      </div>

      {/* --- Compare section --------------------------------------------------------- */}
      <section className="rank-section">
        <div className="rank-section-head">
          <h2>Refine the ranking</h2>
          <div className="rank-section-controls">
            <Dropdown
              value={focus}
              options={focusOptions}
              onChange={(e) => void handleFocusChange(e.value)}
              filter
              placeholder="Focus on a book"
              className="rank-focus"
              disabled={loading || ratedBooks.length < 2}
            />
            <span className="rank-counter">
              {comparedThisVisit} comparison{comparedThisVisit === 1 ? '' : 's'} this visit
            </span>
          </div>
        </div>

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
          <ComparePair left={pair.left} right={pair.right} sending={sending} onChoose={(w) => void handleChoose(w)} />
        ) : (
          <div className="empty-state">
            <p>
              No more pairs to compare{focus != null ? ' for this book' : ''}. The ranking is as
              refined as it gets for now.
            </p>
          </div>
        )}
      </section>

      {/* --- Ranking table ----------------------------------------------------------- */}
      <section className="rank-section">
        <div className="rank-section-head">
          <h2>Ranking</h2>
          <div className="rank-section-controls">
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
          <Column
            header="Comparisons"
            field="comparison_count"
            style={{ width: '8rem' }}
          />
          <Column header="Confidence" body={confidenceBody} style={{ width: '9rem' }} />
          <Column header="±" body={uncertaintyBody} style={{ width: '6rem' }} />
        </DataTable>
      </section>
    </>
  );
}
