import { Calendar } from 'primereact/calendar';
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
import { BookCover, Panel, SearchInput, SectionLabel, StatCard } from '../ui';

import './Stats.css';

interface Option<T> {
  label: string;
  value: T;
}

const PRESETS: Option<PresetRange>[] = [
  { label: 'This year', value: 'thisYear' },
  { label: 'Last year', value: 'lastYear' },
  { label: '12 months', value: 'last12Months' },
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
    bar: read('--app-accent', '#4c6ef5'),
    text: read('--app-text', '#1b1f27'),
    muted: read('--app-text-muted', '#6b7280'),
    border: read('--app-border', '#e7e9ee'),
  };
}

/** Read a single themed accent colour (for sparkline strokes). */
function readVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
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

  // Theme key: recompute chart/spark colors when the theme toggles.
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

  // Sparkline trends built from the monthly (or whatever grouping) buckets.
  const booksTrend = useMemo(() => (data ? data.buckets.map((b) => b.books) : []), [data]);
  const pagesTrend = useMemo(() => (data ? data.buckets.map((b) => b.pages) : []), [data]);

  // Themed spark colours (recomputed on theme toggle via themeKey).
  const sparkColors = useMemo(
    () => ({
      accent: readVar('--app-accent', '#4c6ef5'),
      green: readVar('--accent-green', '#1f9d6b'),
      orange: readVar('--accent-orange', '#e08a2b'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeKey],
  );

  const allBooks = useMemo(() => data?.books ?? [], [data]);
  const filteredBooks = useMemo(
    () => filterBooks(allBooks, tableSearch),
    [allBooks, tableSearch],
  );

  const coverTemplate = (book: Book) => (
    <BookCover src={book.cover_url} title={book.title} size="thumb" />
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
      <Panel label="Reading · overview" icon="pi pi-chart-bar" className="stats-controls-panel">
        <div className="stats-controls">
          <div className="stats-control">
            <SectionLabel as="span">Period</SectionLabel>
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
            <SectionLabel as="span">Group by</SectionLabel>
            <SelectButton
              value={groupBy}
              options={GROUP_OPTIONS}
              onChange={(e) => e.value != null && setGroupBy(e.value)}
              allowEmpty={false}
            />
          </div>
          <div className="stats-control">
            <SectionLabel as="span">Metric</SectionLabel>
            <SelectButton
              value={metric}
              options={METRIC_OPTIONS}
              onChange={(e) => e.value != null && setMetric(e.value)}
              allowEmpty={false}
            />
          </div>
        </div>
      </Panel>

      {error && <Message severity="error" text={error} className="stats-error" />}

      <Panel label="Summary · this range">
        <div className="stats-summary">
          {loading || !summary ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="stats-kpi">
                <Skeleton width="55%" height="0.75rem" />
                <Skeleton width="45%" height="2rem" />
                <Skeleton width="100%" height="1.5rem" />
              </div>
            ))
          ) : (
            <>
              <StatCard
                label="Books read"
                value={summary.books.toLocaleString()}
                trend={booksTrend}
                sparkColor={sparkColors.accent}
              />
              <StatCard
                label="Pages read"
                value={summary.pages.toLocaleString()}
                trend={pagesTrend}
                sparkColor={sparkColors.green}
              />
              <StatCard
                label="Average stars"
                value={summary.average_stars != null ? summary.average_stars.toFixed(2) : '—'}
                tone={summary.average_stars != null ? 'green' : 'muted'}
              />
              <StatCard
                label="Period"
                value={
                  <span className="stats-period-value">
                    {formatPeriod(data?.date_from ?? null, data?.date_to ?? null)}
                  </span>
                }
                tone="muted"
              />
            </>
          )}
        </div>
      </Panel>

      <Panel label={metric === 'pages' ? 'Pages read · by period' : 'Books read · by period'}>
        {loading ? (
          <Skeleton width="100%" height="360px" />
        ) : chartOption && data && data.buckets.length > 0 ? (
          <PlotChart option={chartOption} height={360} />
        ) : (
          <div className="empty-state">
            <i className="pi pi-chart-bar" style={{ fontSize: '2.5rem' }} />
            <p>No finished books in this range.</p>
          </div>
        )}
      </Panel>

      <Panel
        label="Finished books"
        actions={
          !loading && (
            <span className="stats-table-count">
              {filteredBooks.length} of {allBooks.length}
            </span>
          )
        }
      >
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
                fullWidth
                className="stats-table-search"
              />
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
      </Panel>
    </div>
  );
}
