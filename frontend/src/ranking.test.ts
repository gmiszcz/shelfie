import { describe, expect, it } from 'vitest';

import { formatScore, newSessionId, rankBooks, shelvesOf } from './ranking';
import type { Book } from './types';

function book(overrides: Partial<Book>): Book {
  return {
    id: 1,
    title: 'Untitled',
    authors: [],
    shelves: [],
    stars: null,
    display_score: null,
    comparison_count: 0,
    rating_uncertainty: null,
    latent_strength: null,
    ...overrides,
  } as Book;
}

describe('rankBooks', () => {
  it('keeps only books with a star rating', () => {
    const books = [book({ id: 1, stars: 4 }), book({ id: 2, stars: null })];
    expect(rankBooks(books).map((b) => b.id)).toEqual([1]);
  });

  it('sorts by display_score desc, then comparison_count desc, then title', () => {
    const books = [
      book({ id: 1, title: 'B', stars: 4, display_score: 4.2, comparison_count: 1 }),
      book({ id: 2, title: 'A', stars: 5, display_score: 4.9, comparison_count: 3 }),
      book({ id: 3, title: 'C', stars: 5, display_score: 4.9, comparison_count: 10 }),
    ];
    // id 3 and id 2 share the top score; id 3 has more comparisons.
    expect(rankBooks(books).map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it('falls back to stars when display_score is null', () => {
    const books = [
      book({ id: 1, title: 'A', stars: 3, display_score: null }),
      book({ id: 2, title: 'B', stars: 5, display_score: null }),
    ];
    expect(rankBooks(books).map((b) => b.id)).toEqual([2, 1]);
  });

  it('breaks a full tie by title', () => {
    const books = [
      book({ id: 1, title: 'Zebra', stars: 4, display_score: 4, comparison_count: 2 }),
      book({ id: 2, title: 'Apple', stars: 4, display_score: 4, comparison_count: 2 }),
    ];
    expect(rankBooks(books).map((b) => b.title)).toEqual(['Apple', 'Zebra']);
  });

  it('filters by shelf', () => {
    const books = [
      book({ id: 1, stars: 4, shelves: ['sci-fi'] }),
      book({ id: 2, stars: 4, shelves: ['history'] }),
    ];
    expect(rankBooks(books, { shelf: 'sci-fi' }).map((b) => b.id)).toEqual([1]);
  });

  it('keeps only 5-star books when onlyTopRated is set', () => {
    const books = [
      book({ id: 1, stars: 5 }),
      book({ id: 2, stars: 4 }),
      book({ id: 3, stars: 5 }),
    ];
    expect(rankBooks(books, { onlyTopRated: true }).map((b) => b.id).sort()).toEqual([1, 3]);
  });

  it('does not mutate the input array', () => {
    const books = [book({ id: 1, stars: 3 }), book({ id: 2, stars: 5 })];
    const original = books.map((b) => b.id);
    rankBooks(books);
    expect(books.map((b) => b.id)).toEqual(original);
  });
});

describe('formatScore', () => {
  it('uses display_score to one decimal', () => {
    expect(formatScore(book({ display_score: 4.92, stars: 5 }))).toBe('4.9');
  });
  it('falls back to stars', () => {
    expect(formatScore(book({ display_score: null, stars: 4 }))).toBe('4.0');
  });
  it('shows -- when unrated', () => {
    expect(formatScore(book({ display_score: null, stars: null }))).toBe('--');
  });
});

describe('shelvesOf', () => {
  it('returns sorted unique shelves', () => {
    const books = [
      book({ shelves: ['sci-fi', 'owned'] }),
      book({ shelves: ['owned', 'history'] }),
    ];
    expect(shelvesOf(books)).toEqual(['history', 'owned', 'sci-fi']);
  });
  it('handles no shelves', () => {
    expect(shelvesOf([book({ shelves: [] })])).toEqual([]);
  });
});

describe('newSessionId', () => {
  it('is hex and at most 32 chars', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id.length).toBeGreaterThan(0);
  });
  it('is different each call', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
