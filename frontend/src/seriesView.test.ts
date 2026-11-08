import { describe, expect, it } from 'vitest';

import {
  filterCounts,
  matchesFilter,
  matchesQuery,
  orderWatching,
  orphanExpected,
} from './seriesView';
import type { ExpectedBook, SeriesSummary } from './types';

function makeSeries(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    series_key: overrides.series_key ?? 'k',
    name: overrides.name ?? 'Name',
    author: overrides.author ?? 'Author',
    aliases: overrides.aliases ?? [],
    owned_volumes: overrides.owned_volumes ?? [],
    missing_volumes: overrides.missing_volumes ?? [],
    owned_count: overrides.owned_count ?? 0,
    read_count: overrides.read_count ?? 0,
    unread_owned_count: overrides.unread_owned_count ?? 0,
    total_known: overrides.total_known ?? null,
    section: overrides.section ?? 'owned',
    started: overrides.started ?? false,
    finished: overrides.finished ?? false,
    watch: overrides.watch ?? false,
    next_expected: overrides.next_expected ?? null,
    next_expected_pl: overrides.next_expected_pl ?? null,
    next_expected_en: overrides.next_expected_en ?? null,
    checking: overrides.checking ?? false,
    last_checked: overrides.last_checked ?? null,
    notes: overrides.notes ?? null,
    search_lang: overrides.search_lang ?? 'pl',
    release_summary: overrides.release_summary ?? null,
  };
}

function next(date: string | null) {
  return { title: 'X', date, source_url: null, confidence: null, status: 'announced' };
}

describe('matchesQuery', () => {
  it('matches across name, author and aliases, all terms must hit', () => {
    const s = makeSeries({ name: 'Way of the Shaman', author: 'Mahanenko', aliases: ['Droga'] });
    expect(matchesQuery(s, '')).toBe(true);
    expect(matchesQuery(s, 'shaman mahanenko')).toBe(true);
    expect(matchesQuery(s, 'droga')).toBe(true);
    expect(matchesQuery(s, 'shaman zzz')).toBe(false);
  });
});

describe('matchesFilter', () => {
  const inProgress = makeSeries({ section: 'in_progress', owned_count: 2 });
  const complete = makeSeries({ section: 'complete', owned_count: 3 });
  const watched = makeSeries({ watch: true, owned_count: 1 });
  const missing = makeSeries({ missing_volumes: [{ number: 2, title: null, published_date: null, source: null }], owned_count: 1 });

  it('buckets by filter id', () => {
    expect(matchesFilter(inProgress, 'all')).toBe(true);
    expect(matchesFilter(inProgress, 'in_progress')).toBe(true);
    expect(matchesFilter(complete, 'in_progress')).toBe(false);
    expect(matchesFilter(complete, 'complete')).toBe(true);
    expect(matchesFilter(watched, 'watching')).toBe(true);
    expect(matchesFilter(inProgress, 'watching')).toBe(false);
    expect(matchesFilter(missing, 'missing')).toBe(true);
    expect(matchesFilter(complete, 'missing')).toBe(false);
    expect(matchesFilter(watched, 'owned')).toBe(true);
  });
});

describe('filterCounts', () => {
  it('counts each bucket over the given set', () => {
    const list = [
      makeSeries({ series_key: 'a', section: 'in_progress', owned_count: 1, watch: true }),
      makeSeries({ series_key: 'b', section: 'complete', owned_count: 2 }),
      makeSeries({
        series_key: 'c',
        section: 'owned',
        owned_count: 1,
        missing_volumes: [{ number: 2, title: null, published_date: null, source: null }],
      }),
    ];
    const counts = filterCounts(list);
    expect(counts.all).toBe(3);
    expect(counts.watching).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.complete).toBe(1);
    expect(counts.missing).toBe(1);
    expect(counts.owned).toBe(3);
  });
});

describe('orderWatching', () => {
  it('keeps only watched series, nearest known date first, unknown dates last', () => {
    const list = [
      makeSeries({ series_key: 'unwatched', watch: false, next_expected: next('2025-01-01') }),
      makeSeries({ series_key: 'nodate', name: 'Z No Date', watch: true, next_expected: next(null) }),
      makeSeries({ series_key: 'far', name: 'Far', watch: true, next_expected_en: next('2027-01-01') }),
      makeSeries({ series_key: 'near', name: 'Near', watch: true, next_expected_en: next('2026-01-01') }),
    ];
    const ordered = orderWatching(list).map((s) => s.series_key);
    expect(ordered).toEqual(['near', 'far', 'nodate']);
  });

  it('breaks date ties by name and sorts unknown-date group by name', () => {
    const list = [
      makeSeries({ series_key: 'b', name: 'Beta', watch: true, next_expected: next(null) }),
      makeSeries({ series_key: 'a', name: 'Alpha', watch: true, next_expected: next(null) }),
    ];
    expect(orderWatching(list).map((s) => s.series_key)).toEqual(['a', 'b']);
  });
});

describe('orphanExpected', () => {
  it('returns waiting-list items not tied to any known series', () => {
    const series = [makeSeries({ series_key: 'known' })];
    const expected: ExpectedBook[] = [
      { id: 1, title: 'In series', author: '', series_key: 'known', series_name: 'K', volume: null, expected_date: null, source_url: null, source: null, confidence: null, notes: null },
      { id: 2, title: 'Orphan', author: '', series_key: null, series_name: null, volume: null, expected_date: null, source_url: null, source: null, confidence: null, notes: null },
      { id: 3, title: 'Unknown series', author: '', series_key: 'ghost', series_name: 'G', volume: null, expected_date: null, source_url: null, source: null, confidence: null, notes: null },
    ];
    const orphans = orphanExpected(expected, series).map((e) => e.id);
    expect(orphans).toEqual([2, 3]);
  });
});
