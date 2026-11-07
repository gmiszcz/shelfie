import { describe, expect, it } from 'vitest';

import type { Book } from '../types';
import {
  applyFilter,
  describeFilter,
  isEmptyFilter,
  type LibraryFilter,
} from './libraryFilter';

function makeBook(over: Partial<Book>): Book {
  return {
    id: 1,
    external_id: null,
    google_volume_id: null,
    title: 'Untitled',
    subtitle: null,
    authors: [],
    translators: [],
    publisher: null,
    published_date: null,
    description: null,
    page_count: 0,
    categories: [],
    language: null,
    isbn_10: null,
    isbn_13: null,
    cover_url: null,
    format: null,
    edition: null,
    series: null,
    volume: null,
    status: 'want',
    stars: null,
    started_on: null,
    finished_on: null,
    pages_read: null,
    shelves: [],
    tags: [],
    review: null,
    notes: null,
    quotes: null,
    signed: false,
    favourite: false,
    condition: null,
    copies: 1,
    purchase_date: null,
    purchase_price: null,
    purchase_from: null,
    metadata_source: 'manual',
    latent_strength: null,
    rating_uncertainty: null,
    display_score: null,
    comparison_count: 0,
    added_at: '2024-01-01',
    updated_at: '2024-01-01',
    ...over,
  };
}

const books: Book[] = [
  makeBook({
    id: 1,
    title: 'Dune',
    authors: ['Frank Herbert'],
    series: 'Dune',
    shelves: ['SciFi'],
    tags: ['space'],
    status: 'finished',
    stars: 5,
  }),
  makeBook({
    id: 2,
    title: 'Hobbit',
    authors: ['J.R.R. Tolkien'],
    series: 'Middle-earth',
    shelves: ['Fantasy'],
    tags: ['adventure'],
    status: 'reading',
    stars: 4,
  }),
  makeBook({
    id: 3,
    title: 'The Fellowship of the Ring',
    authors: ['J.R.R. Tolkien'],
    series: 'Middle-earth',
    shelves: ['Fantasy'],
    tags: ['epic'],
    status: 'want',
    stars: null,
  }),
];

describe('isEmptyFilter', () => {
  it('treats null/undefined/empty as empty', () => {
    expect(isEmptyFilter(null)).toBe(true);
    expect(isEmptyFilter(undefined)).toBe(true);
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ query: '   ' })).toBe(true);
    expect(isEmptyFilter({ book_ids: [] })).toBe(true);
  });
  it('detects any active constraint', () => {
    expect(isEmptyFilter({ query: 'x' })).toBe(false);
    expect(isEmptyFilter({ min_stars: 0 })).toBe(false);
    expect(isEmptyFilter({ book_ids: [1] })).toBe(false);
  });
});

describe('applyFilter', () => {
  it('returns all books for an empty filter', () => {
    expect(applyFilter(books, null)).toHaveLength(3);
    expect(applyFilter(books, {})).toHaveLength(3);
  });

  it('matches query against title, author and series (case-insensitive)', () => {
    expect(applyFilter(books, { query: 'dune' }).map((b) => b.id)).toEqual([1]);
    expect(applyFilter(books, { query: 'tolkien' }).map((b) => b.id)).toEqual([2, 3]);
    expect(applyFilter(books, { query: 'middle-earth' }).map((b) => b.id)).toEqual([2, 3]);
  });

  it('filters by series, author, shelf, tag and status', () => {
    expect(applyFilter(books, { series: 'middle-earth' }).map((b) => b.id)).toEqual([2, 3]);
    expect(applyFilter(books, { author: 'frank herbert' }).map((b) => b.id)).toEqual([1]);
    expect(applyFilter(books, { shelf: 'fantasy' }).map((b) => b.id)).toEqual([2, 3]);
    expect(applyFilter(books, { tag: 'space' }).map((b) => b.id)).toEqual([1]);
    expect(applyFilter(books, { status: 'reading' }).map((b) => b.id)).toEqual([2]);
  });

  it('filters by minimum stars (null stars treated as 0)', () => {
    expect(applyFilter(books, { min_stars: 5 }).map((b) => b.id)).toEqual([1]);
    expect(applyFilter(books, { min_stars: 4 }).map((b) => b.id)).toEqual([1, 2]);
  });

  it('filters by explicit book_ids', () => {
    expect(applyFilter(books, { book_ids: [3, 1] }).map((b) => b.id)).toEqual([1, 3]);
  });

  it('combines constraints with AND', () => {
    expect(
      applyFilter(books, { author: 'J.R.R. Tolkien', status: 'want' }).map((b) => b.id),
    ).toEqual([3]);
  });
});

describe('describeFilter', () => {
  it('summarizes active constraints', () => {
    const f: LibraryFilter = { author: 'Tolkien', min_stars: 4 };
    expect(describeFilter(f)).toBe('author: Tolkien · 4+ stars');
  });
  it('falls back to "all books"', () => {
    expect(describeFilter({})).toBe('all books');
  });
});
