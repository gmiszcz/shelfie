import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { useMemo, useRef, useState } from 'react';

import { BookDetailDialog } from '../components/BookDetailDialog';
import { SeriesCard } from '../components/SeriesCard';
import { useSeries } from '../hooks/useSeries';
import { api } from '../services/api';
import { SearchInput } from '../ui';
import type { Book, ReadingStatus, SeriesSummary } from '../types';

import './Series.css';

const SECTIONS: { id: SeriesSummary['section']; label: string; icon: string; hint: string }[] = [
  { id: 'in_progress', label: 'In progress', icon: 'pi pi-book',
    hint: 'Started, not finished — with unread or missing volumes.' },
  { id: 'owned', label: 'Watched & other', icon: 'pi pi-bell',
    hint: 'Watched series and series you own but have not started.' },
  { id: 'complete', label: 'Complete', icon: 'pi pi-check-circle',
    hint: 'Every known volume read.' },
];

function matches(series: SeriesSummary, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const hay = [series.name, series.author, ...series.aliases].join(' ').toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

export function Series() {
  const { series, expected, alerts, loading, error, setWatch, refresh, removeExpected } =
    useSeries();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Book | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const toast = useRef<Toast>(null);

  const notifyError = (message: string) =>
    toast.current?.show({ severity: 'error', summary: 'Error', detail: message });

  const filtered = useMemo(
    () => series.filter((s) => matches(s, query.trim())),
    [series, query],
  );

  const bySectionInProgress = filtered.filter((s) => s.section === 'in_progress');
  const complete = filtered.filter((s) => s.section === 'complete');
  const middle = filtered.filter(
    (s) => s.section === 'owned' || (s.watch && s.section !== 'in_progress' && s.section !== 'complete'),
  );

  const grouped: Record<SeriesSummary['section'], SeriesSummary[]> = {
    in_progress: bySectionInProgress,
    owned: middle,
    complete,
  };

  const openVolume = async (bookId: number) => {
    try {
      setSelected(await api.getBook(bookId));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not open book');
    }
  };

  const handleRefresh = async (key: string) => {
    setRefreshingKey(key);
    try {
      await refresh(key);
      toast.current?.show({ severity: 'success', summary: 'Refreshed', life: 2000 });
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setRefreshingKey(null);
    }
  };

  const handleFavourite = async (id: number, next: boolean) => {
    try {
      await api.updateBook(id, { favourite: next });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, favourite: next } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update favourite');
    }
  };

  const handleStatus = async (id: number, status: ReadingStatus) => {
    try {
      await api.updateBook(id, { status });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update status');
    }
  };

  const handleStars = async (id: number, stars: number | null) => {
    try {
      await api.updateBook(id, { stars });
      setSelected((prev) => (prev && prev.id === id ? { ...prev, stars } : prev));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Could not update rating');
    }
  };

  const alertCount = alerts?.count ?? 0;
  const showAlerts = !alertsDismissed && alertCount > 0;

  return (
    <>
      <Toast ref={toast} position="bottom-right" />

      <div className="series-toolbar">
        <div className="series-toolbar-head">
          <h2 className="series-title">
            <i className="pi pi-bookmark" aria-hidden="true" /> Series
            {alertCount > 0 && <span className="series-badge">{alertCount}</span>}
          </h2>
          <span className="series-count">
            {loading ? 'Loading…' : `${filtered.length} of ${series.length} series`}
          </span>
        </div>

        <div className="series-toolbar-search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Filter series by name, author or alias…"
            ariaLabel="Filter series"
          />
        </div>
      </div>

      {showAlerts && (
        <section className="series-alerts" aria-label="Series notifications">
          <div className="series-alerts-head">
            <strong>
              <i className="pi pi-bell" aria-hidden="true" /> {alertCount} notification
              {alertCount === 1 ? '' : 's'}
            </strong>
            <Button
              icon="pi pi-times"
              rounded
              text
              aria-label="Dismiss notifications"
              onClick={() => setAlertsDismissed(true)}
            />
          </div>
          <ul className="series-alerts-list">
            {alerts?.new_volume.map((a) => (
              <li key={`nv-${a.series_key}`}>
                <i className="pi pi-sparkles" aria-hidden="true" /> {a.message}
                {a.detail && <span className="series-alert-detail"> · {a.detail}</span>}
              </li>
            ))}
            {alerts?.in_progress.map((a) => (
              <li key={`ip-${a.series_key}`}>
                <i className="pi pi-book" aria-hidden="true" /> {a.message}
                {a.detail && <span className="series-alert-detail"> · {a.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p style={{ color: 'var(--red-400)' }}>{error}</p>}

      {!loading && series.length === 0 && (
        <div className="empty-state">
          <i className="pi pi-bookmark" style={{ fontSize: '2.5rem' }} />
          <p>No series yet. Series are detected from the books in your library.</p>
        </div>
      )}

      {SECTIONS.map((section) => {
        const items = grouped[section.id];
        if (items.length === 0) {
          return null;
        }
        return (
          <section key={section.id} className="series-section">
            <div className="series-section-head">
              <h3>
                <i className={section.icon} aria-hidden="true" /> {section.label}
                <span className="series-section-count">{items.length}</span>
              </h3>
              <p className="series-section-hint">{section.hint}</p>
            </div>
            <div className="series-grid">
              {items.map((s) => (
                <SeriesCard
                  key={s.series_key}
                  series={s}
                  onOpenVolume={openVolume}
                  onToggleWatch={(key, watch) =>
                    setWatch(key, watch).catch((err) =>
                      notifyError(err instanceof Error ? err.message : 'Could not toggle watch'),
                    )
                  }
                  onRefresh={handleRefresh}
                  refreshing={refreshingKey === s.series_key}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Waiting list: not-yet-owned upcoming books. */}
      <section className="series-section">
        <div className="series-section-head">
          <h3>
            <i className="pi pi-clock" aria-hidden="true" /> Waiting list
            <span className="series-section-count">{expected.length}</span>
          </h3>
          <p className="series-section-hint">
            Upcoming / not-yet-owned books from watched series and manual adds.
          </p>
        </div>
        {expected.length === 0 ? (
          <p className="series-waiting-empty">
            Nothing on the waiting list. Watch a series or ask the assistant to add an upcoming
            book.
          </p>
        ) : (
          <ul className="series-waiting-list">
            {expected.map((e) => (
              <li key={e.id} className="series-waiting-item">
                <div className="series-waiting-main">
                  <span className="series-waiting-title">{e.title}</span>
                  <span className="series-waiting-meta">
                    {e.author}
                    {e.series_name && ` · ${e.series_name}`}
                    {e.volume && ` · vol. ${e.volume}`}
                    {e.expected_date && ` · ${e.expected_date}`}
                  </span>
                </div>
                <div className="series-waiting-actions">
                  {e.source_url && (
                    <a href={e.source_url} target="_blank" rel="noreferrer noopener">
                      source
                    </a>
                  )}
                  <Button
                    icon="pi pi-trash"
                    rounded
                    text
                    severity="danger"
                    aria-label={`Remove ${e.title} from the waiting list`}
                    onClick={() =>
                      removeExpected(e.id).catch((err) =>
                        notifyError(err instanceof Error ? err.message : 'Could not remove'),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BookDetailDialog
        book={selected}
        onHide={() => setSelected(null)}
        onStatus={handleStatus}
        onStars={handleStars}
        onDelete={() => undefined}
        onEdit={() => undefined}
        onFavourite={handleFavourite}
      />
    </>
  );
}
