import type { ExpectedBook, NextExpected, SeriesFilterId, SeriesSummary } from './types';

/** Does a series match the free-text search needle (name, author, aliases)? */
export function matchesQuery(series: SeriesSummary, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const hay = [series.name, series.author, ...series.aliases].join(' ').toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

/** Whether a series belongs to the given filter bucket. */
export function matchesFilter(series: SeriesSummary, filter: SeriesFilterId): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'watching':
      return series.watch;
    case 'in_progress':
      return series.section === 'in_progress';
    case 'missing':
      return series.missing_volumes.length > 0;
    case 'complete':
      return series.section === 'complete';
    case 'owned':
      return series.owned_count > 0;
    default:
      return true;
  }
}

/** Count of series in each filter bucket (over the search-filtered set). */
export function filterCounts(series: SeriesSummary[]): Record<SeriesFilterId, number> {
  const counts: Record<SeriesFilterId, number> = {
    all: series.length,
    watching: 0,
    in_progress: 0,
    missing: 0,
    complete: 0,
    owned: 0,
  };
  for (const s of series) {
    if (s.watch) counts.watching += 1;
    if (s.section === 'in_progress') counts.in_progress += 1;
    if (s.missing_volumes.length > 0) counts.missing += 1;
    if (s.section === 'complete') counts.complete += 1;
    if (s.owned_count > 0) counts.owned += 1;
  }
  return counts;
}

/** Pick the nearest known date across a watched series' expected editions (PL/EN/combined). */
function nearestDate(series: SeriesSummary): string | null {
  const candidates: (NextExpected | null)[] = [
    series.next_expected_en,
    series.next_expected_pl,
    series.next_expected,
  ];
  const dates = candidates
    .map((e) => e?.date ?? null)
    .filter((d): d is string => !!d)
    .sort();
  return dates.length > 0 ? dates[0] : null;
}

/**
 * Order the watched series for the "Watching" section: those with a nearest known date
 * first (ascending), then those with no known date, each group kept stable by name.
 */
export function orderWatching(series: SeriesSummary[]): SeriesSummary[] {
  const watched = series.filter((s) => s.watch);
  return [...watched].sort((a, b) => {
    const da = nearestDate(a);
    const db = nearestDate(b);
    if (da && db) {
      if (da !== db) return da < db ? -1 : 1;
      return a.name.localeCompare(b.name);
    }
    if (da) return -1; // known date first
    if (db) return 1;
    return a.name.localeCompare(b.name); // both unknown: by name
  });
}

/** The known series keys, so waiting-list items with no series can be shown in Watching. */
export function seriesKeySet(series: SeriesSummary[]): Set<string> {
  return new Set(series.map((s) => s.series_key));
}

/** Waiting-list items that are NOT tied to any known series (shown in Watching too). */
export function orphanExpected(
  expected: ExpectedBook[],
  series: SeriesSummary[],
): ExpectedBook[] {
  const keys = seriesKeySet(series);
  return expected.filter((e) => !e.series_key || !keys.has(e.series_key));
}
