import { Calendar } from 'primereact/calendar';
import { Card } from 'primereact/card';
import { Column } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { Message } from 'primereact/message';
import { Rating } from 'primereact/rating';
import { SelectButton } from 'primereact/selectbutton';
import { Skeleton } from 'primereact/skeleton';
import { Tag } from 'primereact/tag';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PlotChart } from '../components/PlotChart';
import { formatAuthors } from '../format';
import { api } from '../services/api';
import {
  barOption,
  filterBooks,
  presetRange,
  toIsoDate,
  type BarColors,
  type PresetRange,
  type StatsMetric,
} from '../statsView';
import type { Book, GroupBy, StatsResponse } from '../types';
import { SearchInput } from '../ui';

import './Stats.css';

interface Option<T> {
  label: string;
  value: T;
}

const PRESETS: Option<PresetRange>[] = [
  { label: 'This year', value: 'thisYear' },
  { label: 'Last year', value: 'lastYear' },
  { label: 'Last 12 months', value: 'last12Months' },
  { label: 'All time', value: 'allTime' },
];

const GROUP_OPTIONS: Option<GroupBy>[] = [
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
  { label: 'Shelf', value: 'shelf' },
  { label: 'Tag', value: 'tag' },
];

const METRIC_OPTIONS: Option<StatsMetric>[] = [
  { label: 'Books', value: 'books' },
  { label: 'Pages', value: 'pages' },
];

/** Read the themed bar colors from the app CSS variables. */
function readBarColors(): BarColors {
  const read = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  return {
    bar: read('--app-accent', '#8b9cff'),
    text: read('--app-text', '#e6e8ee'),
    muted: read('--app-text-muted', '#9aa0b0'),
    border: read('--app-border', '#2e3342'),
  };
}

function formatPeriod(from: string | null, to: string | null): string {
  if (!from && !to) return 'All time';
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Until ${to}`;
}

export function Stats() {
  const [preset, setPreset] = useState<PresetRange>('thisYear');
  const [customRange, setCustomRange] = useState<(Date | null)[] | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('month');
  const [metric, setMetric] = useState<StatsMetric>('books');
  const [tableSearch, setTableSearch] = useState('');

  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Theme key: recompute chart colors when the theme toggles.
  const [themeKey, setThemeKey] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey((k) => k + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Resolve the active range: a complete custom range wins over the preset.
  const range = useMemo(() => {
    const [start, end] = customRange ?? [];
    if (start && end) {
      return { from: toIsoDate(start), to: toIsoDate(end) };
    }
    return presetRange(preset);
  }, [customRange, preset]);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.stats(groupBy, range.from, range.to));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statistics');
      setData(null);
    } finally {
      setLoading(false);
    }
    // Refetch only when the range or grouping changes — NOT on a metric switch.
  }, [groupBy, range.from, range.to]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  const chartOption = useMemo(() => {
    if (!data) return null;
    return barOption(data.buckets, metric, readBarColors());
    // themeKey forces recompute so bar colors follow the theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric, themeKey]);

  const summary = data?.summary;

  const allBooks = useMemo(() => data?.books ?? [], [data]);
  const filteredBooks = useMemo(
    () => filterBooks(allBooks, tableSearch),
    [allBooks, tableSearch],
  );

  const coverTemplate = (book: Book) => (
    <div className="stats-cover">
      {book.cover_url ? (
        <img src={book.cover_url} alt={`Cover of ${book.title}`} loading="lazy" />
      ) : (
        <i className="pi pi-book" />
      )}
    </div>
  );

  const authorsTemplate = (book: Book) => formatAuthors(book.authors);

  const starsTemplate = (book: Book) =>
    book.stars != null ? (
      <Rating value={Math.round(book.stars)} readOnly cancel={false} />
    ) : (
      <span className="stats-muted">—</span>
    );

  const shelvesTemplate = (book: Book) => (
    <div className="stats-tags">
      {book.shelves.length ? (
        book.shelves.map((s) => <Tag key={s} value={s} />)
      ) : (
        <span className="stats-muted">—</span>
      )}
    </div>
  );

  return (
    <div className="stats-page">
      <div className="stats-controls">
        <div className="stats-control">
          <label>Period</label>
          <div className="stats-range">
            <SelectButton
              value={preset}
              options={PRESETS}
              onChange={(e) => {
                if (e.value == null) return;
                setPreset(e.value);
                setCustomRange(null);
              }}
              allowEmpty={false}
            />
            <Calendar
              value={customRange as Date[] | null}
              onChange={(e) => setCustomRange((e.value as (Date | null)[] | null) ?? null)}
              selectionMode="range"
              readOnlyInput
              showButtonBar
              placeholder="Custom range"
              dateFormat="yy-mm-dd"
            />
          </div>
        </div>
        <div className="stats-control">
          <label>Group by</label>
          <SelectButton
            value={groupBy}
            options={GROUP_OPTIONS}
            onChange={(e) => e.value != null && setGroupBy(e.value)}
            allowEmpty={false}
          />
        </div>
        <div className="stats-control">
          <label>Metric</label>
          <SelectButton
            value={metric}
            options={METRIC_OPTIONS}
            onChange={(e) => e.value != null && setMetric(e.value)}
            allowEmpty={false}
          />
        </div>
      </div>

      {error && <Message severity="error" text={error} className="stats-error" />}

      <div className="stats-summary">
        {loading || !summary ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="stats-card">
              <div className="stats-card-inner">
                <Skeleton width="60%" height="0.9rem" />
                <Skeleton width="40%" height="1.6rem" />
              </div>
            </Card>
          ))
        ) : (
          <>
            <Card className="stats-card">
              <div className="stats-card-inner">
                <span className="stats-card-label">Books read</span>
                <span className="stats-card-value">{summary.books.toLocaleString()}</span>
              </div>
            </Card>
            <Card className="stats-card">
              <div className="stats-card-inner">
                <span className="stats-card-label">Pages read</span>
                <span className="stats-card-value">{summary.pages.toLocaleString()}</span>
              </div>
            </Card>
            <Card className="stats-card">
              <div className="stats-card-inner">
                <span className="stats-card-label">Average stars</span>
                <span className="stats-card-value">
                  {summary.average_stars != null ? summary.average_stars.toFixed(2) : '—'}
                </span>
              </div>
            </Card>
            <Card className="stats-card">
              <div className="stats-card-inner">
                <span className="stats-card-label">Period</span>
                <span className="stats-card-value stats-card-period">
                  {formatPeriod(data?.date_from ?? null, data?.date_to ?? null)}
                </span>
              </div>
            </Card>
          </>
        )}
      </div>

      <Card className="stats-chart-card">
        {loading ? (
          <Skeleton width="100%" height="350px" />
        ) : chartOption && data && data.buckets.length > 0 ? (
          <PlotChart option={chartOption} height={360} />
        ) : (
          <div className="empty-state">
            <i className="pi pi-chart-bar" style={{ fontSize: '2.5rem' }} />
            <p>No finished books in this range.</p>
          </div>
        )}
      </Card>

      <Card className="stats-table-card">
        {loading ? (
          <Skeleton width="100%" height="300px" />
        ) : (
          <div className="stats-table">
            <div className="stats-table-toolbar">
              <SearchInput
                value={tableSearch}
                onChange={setTableSearch}
                ariaLabel="Search finished books"
                placeholder="Search title, author, series, shelf or tag…"
                fullWidth={false}
                className="stats-table-search"
              />
              <span className="stats-table-count">
                {filteredBooks.length} of {allBooks.length}
              </span>
            </div>
            <DataTable
              value={filteredBooks}
              paginator
              rows={10}
              sortMode="single"
              removableSort
              dataKey="id"
              emptyMessage={
                allBooks.length === 0
                  ? 'No finished books in this range.'
                  : 'No books match your search.'
              }
              responsiveLayout="scroll"
            >
              <Column header="" body={coverTemplate} style={{ width: '3.5rem' }} />
              <Column field="title" header="Title" sortable />
              <Column header="Authors" body={authorsTemplate} sortable sortField="authors" />
              <Column field="finished_on" header="Finished" sortable style={{ width: '9rem' }} />
              <Column header="Stars" body={starsTemplate} sortable sortField="stars" />
              <Column header="Shelves" body={shelvesTemplate} />
            </DataTable>
          </div>
        )}
      </Card>
    </div>
  );
}
