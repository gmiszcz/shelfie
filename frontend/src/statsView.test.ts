import { describe, expect, it } from 'vitest';

import type { Book, StatsBucket } from './types';
import { barOption, filterBooks, presetRange, toIsoDate, type BarColors } from './statsView';

const COLORS: BarColors = {
  bar: '#8b9cff',
  text: '#e6e8ee',
  muted: '#9aa0b0',
  border: '#2e3342',
};

describe('toIsoDate', () => {
  it('formats a local date as YYYY-MM-DD, zero-padded', () => {
    expect(toIsoDate(new Date(2024, 0, 5))).toBe('2024-01-05');
    expect(toIsoDate(new Date(2024, 11, 31))).toBe('2024-12-31');
  });

  it('uses LOCAL components, not UTC', () => {
    // Late in the day, local date must match the Date's own local getters,
    // regardless of the host timezone offset (toISOString would drift).
    const d = new Date(2024, 2, 10, 23, 30, 0);
    expect(toIsoDate(d)).toBe(`2024-03-10`);
    expect(toIsoDate(d)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`,
    );
  });
});

describe('presetRange', () => {
  const today = new Date(2024, 5, 15); // 2024-06-15

  it('thisYear spans Jan 1 to Dec 31 of the current year', () => {
    expect(presetRange('thisYear', today)).toEqual({ from: '2024-01-01', to: '2024-12-31' });
  });

  it('lastYear spans the full previous year', () => {
    expect(presetRange('lastYear', today)).toEqual({ from: '2023-01-01', to: '2023-12-31' });
  });

  it('last12Months ends today and starts one year earlier', () => {
    expect(presetRange('last12Months', today)).toEqual({ from: '2023-06-15', to: '2024-06-15' });
  });

  it('allTime has no bounds', () => {
    expect(presetRange('allTime', today)).toEqual({ from: null, to: null });
  });

  it('handles year boundaries (Dec 31 and Jan 1)', () => {
    expect(presetRange('thisYear', new Date(2025, 11, 31))).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    });
    expect(presetRange('last12Months', new Date(2025, 0, 1))).toEqual({
      from: '2024-01-01',
      to: '2025-01-01',
    });
  });

  it('defaults the reference date to now when omitted', () => {
    const r = presetRange('thisYear');
    const year = new Date().getFullYear();
    expect(r).toEqual({ from: `${year}-01-01`, to: `${year}-12-31` });
  });
});

describe('barOption', () => {
  const buckets: StatsBucket[] = [
    { key: 'Fiction', books: 3, pages: 900 },
    { key: 'History', books: 1, pages: 320 },
  ];

  it('builds a single category bar series from bucket keys', () => {
    const option = barOption(buckets, 'books', COLORS) as {
      xAxis: { type: string; data: string[] };
      series: { type: string; name: string; data: number[] }[];
    };
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.data).toEqual(['Fiction', 'History']);
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe('bar');
    expect(option.series[0].name).toBe('Books');
    expect(option.series[0].data).toEqual([3, 1]);
  });

  it('uses the pages metric when requested', () => {
    const option = barOption(buckets, 'pages', COLORS) as {
      series: { name: string; data: number[] }[];
    };
    expect(option.series[0].name).toBe('Pages');
    expect(option.series[0].data).toEqual([900, 320]);
  });

  it('does not rotate labels for few buckets', () => {
    const option = barOption(buckets, 'books', COLORS) as {
      xAxis: { axisLabel: { rotate: number } };
    };
    expect(option.xAxis.axisLabel.rotate).toBe(0);
  });

  it('rotates labels when there are many buckets', () => {
    const many: StatsBucket[] = Array.from({ length: 12 }, (_, i) => ({
      key: `2024-${String(i + 1).padStart(2, '0')}`,
      books: i,
      pages: i * 100,
    }));
    const option = barOption(many, 'books', COLORS) as {
      xAxis: { axisLabel: { rotate: number } };
    };
    expect(option.xAxis.axisLabel.rotate).toBe(45);
  });

  it('handles empty buckets without throwing', () => {
    const option = barOption([], 'books', COLORS) as {
      xAxis: { data: string[] };
      series: { data: number[] }[];
    };
    expect(option.xAxis.data).toEqual([]);
    expect(option.series[0].data).toEqual([]);
  });
});

describe('filterBooks', () => {
  /** Build a Book with only the fields filterBooks reads; the rest are filler. */
  const makeBook = (over: Partial<Book>): Book =>
    ({
      id: 1,
      title: '',
      subtitle: null,
      authors: [],
      series: null,
      shelves: [],
      tags: [],
      ...over,
    }) as Book;

  const books: Book[] = [
    makeBook({
      id: 1,
      title: 'Dune',
      authors: ['Frank Herbert'],
      series: 'Dune Chronicles',
      shelves: ['sci-fi'],
      tags: ['classic'],
    }),
    makeBook({
      id: 2,
      title: 'The Hobbit',
      subtitle: 'There and Back Again',
      authors: ['J.R.R. Tolkien'],
      shelves: ['fantasy'],
      tags: ['owned'],
    }),
    makeBook({
      id: 3,
      title: 'Foundation',
      authors: ['Isaac Asimov'],
      shelves: ['sci-fi'],
      tags: [],
    }),
  ];

  it('returns all books for an empty or whitespace query', () => {
    expect(filterBooks(books, '')).toHaveLength(3);
    expect(filterBooks(books, '   ')).toHaveLength(3);
  });

  it('matches by title (case-insensitive)', () => {
    expect(filterBooks(books, 'dune').map((b) => b.id)).toEqual([1]);
    expect(filterBooks(books, 'HOBBIT').map((b) => b.id)).toEqual([2]);
  });

  it('matches by author', () => {
    expect(filterBooks(books, 'asimov').map((b) => b.id)).toEqual([3]);
  });

  it('matches by subtitle', () => {
    expect(filterBooks(books, 'there and back').map((b) => b.id)).toEqual([2]);
  });

  it('matches by series', () => {
    expect(filterBooks(books, 'chronicles').map((b) => b.id)).toEqual([1]);
  });

  it('matches by shelf and by tag', () => {
    expect(filterBooks(books, 'sci-fi').map((b) => b.id)).toEqual([1, 3]);
    expect(filterBooks(books, 'classic').map((b) => b.id)).toEqual([1]);
  });

  it('requires ALL space-separated terms to match (AND)', () => {
    expect(filterBooks(books, 'sci-fi asimov').map((b) => b.id)).toEqual([3]);
    expect(filterBooks(books, 'dune tolkien')).toHaveLength(0);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterBooks(books, 'zzzznotfound')).toHaveLength(0);
  });

  it('tolerates null/undefined optional fields', () => {
    const sparse = [makeBook({ id: 9, title: 'Solo', authors: [], series: null })];
    expect(filterBooks(sparse, 'solo').map((b) => b.id)).toEqual([9]);
    expect(filterBooks(sparse, 'anything')).toHaveLength(0);
  });
});
