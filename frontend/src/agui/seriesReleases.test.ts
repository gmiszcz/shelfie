import { describe, expect, it } from 'vitest';

import type { Book, SeriesSummary } from '../types';
import { createTools, matchSeries } from './tools';

function series(over: Partial<SeriesSummary>): SeriesSummary {
  return {
    series_key: 'king s dark tidings',
    name: "King's Dark Tidings",
    author: 'Kel Kade',
    aliases: ['Kroniki Mroku'],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 7,
    read_count: 7,
    unread_owned_count: 0,
    total_known: 7,
    section: 'in_progress',
    started: true,
    finished: false,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: null,
    notes: null,
    ...over,
  };
}

const KDT = series({});
const OTHER = series({ series_key: 'dune', name: 'Dune', aliases: [], author: 'Frank Herbert' });
const BOOKS = [
  { id: 1, title: 'Powiernik mieczy', series: "King's Dark Tidings" } as Book,
];

describe('matchSeries', () => {
  it('finds a series by its Polish alias, case and diacritics ignored', () => {
    expect(matchSeries([OTHER, KDT], 'kronik mroku', BOOKS)?.series_key).toBe(KDT.series_key);
  });

  it('finds a series by a book title in it', () => {
    expect(matchSeries([OTHER, KDT], 'Powiernik mieczy', BOOKS)?.series_key).toBe(KDT.series_key);
  });

  it('returns null when nothing matches', () => {
    expect(matchSeries([OTHER, KDT], 'Wiedźmin', BOOKS)).toBeNull();
  });
});

describe('series_releases tool', () => {
  it('refresh=true starts the web check and polls until it finishes', async () => {
    let gets = 0;
    const done = series({
      next_expected_en: {
        title: 'Ritual of Ruin',
        date: '2025-11-11',
        status: 'released',
        source_url: 'https://kelkade.com/',
        confidence: 'medium',
      },
    });
    const tool = createTools({
      getBooks: () => BOOKS,
      series: {
        list: async () => [OTHER, KDT],
        refresh: async () => series({ checking: true }),
        get: async () => {
          gets += 1;
          return gets < 2 ? series({ checking: true }) : done;
        },
        pollMs: 1,
        timeoutMs: 1000,
      },
    }).find((t) => t.name === 'series_releases')!;

    const out = (await tool.execute({ name: 'Kroniki Mroku', refresh: true })) as Record<
      string,
      unknown
    >;
    expect(out.ok).toBe(true);
    expect(out.refreshed).toBe(true);
    expect(out.next_original).toMatchObject({ date: '2025-11-11', status: 'released' });
    expect(out.next_polish).toMatchObject({ date: 'not announced' });
  });
});
