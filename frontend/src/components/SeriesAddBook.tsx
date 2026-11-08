import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { InputText } from 'primereact/inputtext';
import { useMemo, useState } from 'react';

import { api } from '../services/api';
import { SearchInput } from '../ui';
import type { Book, SeriesSummary } from '../types';

import './SeriesAddBook.css';

interface Props {
  /** The whole library. */
  books: Book[];
  /** Existing series (name suggestions; picking one adds the book to it). */
  series: SeriesSummary[];
  /** Start watching a series for new volumes (web research). */
  onWatch: (key: string) => Promise<void>;
  /** Called after a book was put in a series so the parent reloads series + books. */
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * "Put a book in a series" — at the bottom of the Series tab.
 *
 * A book added from Google Books has no series, so it never shows up here and its series
 * cannot be watched. This panel lists the newest books with NO series (searchable), lets the
 * user type a series name (an existing one is suggested, a new name creates the series) and a
 * volume, and by default also starts watching the series for new volumes.
 */
export function SeriesAddBook({ books, series, onWatch, onDone, onError }: Props) {
  const [query, setQuery] = useState('');
  const [bookId, setBookId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [volume, setVolume] = useState('');
  const [watch, setWatch] = useState(true);
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return books
      .filter((b) => !b.series)
      .filter((b) => {
        if (terms.length === 0) return true;
        const hay = [b.title, b.subtitle ?? '', ...b.authors].join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''))
      .slice(0, terms.length ? 8 : 5);
  }, [books, query]);

  const picked = books.find((b) => b.id === bookId) ?? null;
  const names = useMemo(() => series.map((s) => s.name).sort((a, b) => a.localeCompare(b)), [series]);

  const save = async () => {
    if (!picked || !name.trim()) return;
    setBusy(true);
    try {
      const summary = await api.addSeriesBook(name.trim(), picked.id, volume.trim() || null);
      if (watch && !summary.watch) {
        await onWatch(summary.series_key);
      }
      onDone(`"${picked.title}" is now in ${summary.name}${watch ? ' (watching)' : ''}`);
      setBookId(null);
      setName('');
      setVolume('');
      setQuery('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add the book to the series');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="series-section series-add-book" aria-label="Put a book in a series">
      <div className="series-section-head">
        <h3>
          <i className="pi pi-plus-circle" aria-hidden="true" /> Put a book in a series
        </h3>
        <p className="series-section-hint">
          Books without a series do not show here. Pick one, name its series, and watch it for
          new volumes.
        </p>
      </div>

      <div className="sab-body">
        <SearchInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setBookId(null);
          }}
          placeholder="Find a book without a series…"
          ariaLabel="Find a book without a series"
        />
        {candidates.length === 0 ? (
          <p className="series-waiting-empty">
            {query.trim() ? 'No book without a series matches.' : 'Every book already has a series.'}
          </p>
        ) : (
          <ul className="sab-candidates">
            {candidates.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={`sab-candidate ${bookId === b.id ? 'sab-candidate--on' : ''}`}
                  aria-pressed={bookId === b.id}
                  onClick={() => setBookId(b.id)}
                >
                  <span className="sab-candidate-title">{b.title}</span>
                  <span className="sab-candidate-meta">{b.authors.join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {picked && (
          <div className="sab-form">
            <InputText
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Series name"
              aria-label="Series name"
              list="sab-series-names"
              className="sab-name"
            />
            <datalist id="sab-series-names">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <InputText
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              placeholder="Vol."
              aria-label="Volume"
              className="sab-volume"
            />
            <label className="sab-watch">
              <Checkbox
                inputId="sab-watch"
                checked={watch}
                onChange={(e) => setWatch(Boolean(e.checked))}
              />
              <span>Watch for new volumes</span>
            </label>
            <Button
              label="Add to series"
              icon="pi pi-check"
              onClick={() => void save()}
              loading={busy}
              disabled={!name.trim()}
            />
          </div>
        )}
      </div>
    </section>
  );
}
