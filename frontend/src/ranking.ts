import type { Book } from './types';

/** How far below its star value a book's display score may sink (backend BAND_WIDTH). */
export const BAND_WIDTH = 0.4;

/** The score band a star value owns on the display scale: [stars - BAND_WIDTH, stars]. */
export function bandOf(stars: number): { floor: number; top: number } {
  const top = Math.round(stars * 10) / 10;
  return { floor: Math.round((top - BAND_WIDTH) * 10) / 10, top };
}

/**
 * The `min_score` / `max_score` query params for a star-filter bucket, per rating contract 1:
 * "N stars" = `display_score > N - 0.5` and `<= N` (e.g. 5 -> 4.6..5.0, 4.5 -> 4.1..4.5).
 *
 * Returns the half-open bounds `{ minScore, maxScore }` to pass to `GET /api/books`, where the
 * backend applies `display_score > minScore AND display_score <= maxScore`.
 */
export function scoreBoundsForStars(stars: number): { minScore: number; maxScore: number } {
  const top = Math.round(stars * 10) / 10;
  return { minScore: Math.round((top - 0.5) * 10) / 10, maxScore: top };
}

/**
 * Keep books whose score falls in a star band: ``minScore < score <= maxScore``.
 * The score is ``display_score``, falling back to the user's ``stars`` when not computed yet.
 */
export function filterByScore<T extends { display_score: number | null; stars: number | null }>(
  books: T[],
  bounds: { minScore: number; maxScore: number },
): T[] {
  return books.filter((b) => {
    const score = b.display_score ?? b.stars;
    return score != null && score > bounds.minScore + 1e-9 && score <= bounds.maxScore + 1e-9;
  });
}

export interface RankOptions {
  /** Keep only books on this shelf. */
  shelf?: string;
  /** Keep only books rated 5 stars. */
  onlyTopRated?: boolean;
}

/**
 * Rank rated books for the ranking table.
 *
 * Only books with a star rating are considered. When `onlyTopRated` is set, the list is
 * narrowed to 5-star books. The order is by refined score (`display_score ?? stars`) desc,
 * then by how many comparisons informed it (`comparison_count`) desc, then by title.
 */
export function rankBooks(books: Book[], options: RankOptions = {}): Book[] {
  const { shelf, onlyTopRated } = options;
  const score = (b: Book): number => b.display_score ?? (b.stars as number);

  return books
    .filter((b) => b.stars != null)
    .filter((b) => (shelf ? b.shelves.includes(shelf) : true))
    .filter((b) => (onlyTopRated ? (b.stars as number) >= 5 : true))
    .slice()
    .sort((a, b) => {
      const byScore = score(b) - score(a);
      if (byScore !== 0) {
        return byScore;
      }
      const byComparisons = b.comparison_count - a.comparison_count;
      if (byComparisons !== 0) {
        return byComparisons;
      }
      return a.title.localeCompare(b.title);
    });
}

/** The refined score as a one-decimal string, or '--' when the book is unrated. */
export function formatScore(book: Book): string {
  const value = book.display_score ?? book.stars;
  return value == null ? '--' : value.toFixed(1);
}

/** A human label for a book's band, e.g. "4.6–5.0", or '--' when unrated. */
export function bandLabel(book: Book): string {
  if (book.stars == null) {
    return '--';
  }
  const { floor, top } = bandOf(book.stars);
  return `${floor.toFixed(1)}\u2013${top.toFixed(1)}`;
}

/**
 * A 0..1 confidence that the book's position within its band is pinned down, derived from the
 * rating uncertainty (lower uncertainty -> higher confidence). A book with no comparisons sits
 * near 0 and one with many sits near 1. Returns 0 when there is no uncertainty estimate yet.
 */
export function confidenceOf(book: Book): number {
  const u = book.rating_uncertainty;
  if (u == null) {
    return 0;
  }
  // Map the standard error through a smooth 1/(1+u) curve: u~1 -> 0.5, u->0 -> 1.
  return 1 / (1 + u);
}

/** A short qualitative confidence label for the ranking table. */
export function confidenceLabel(book: Book): string {
  if (book.stars == null) {
    return '--';
  }
  if (book.comparison_count === 0) {
    return 'Unrefined';
  }
  const c = confidenceOf(book);
  if (c >= 0.66) {
    return 'High';
  }
  if (c >= 0.45) {
    return 'Medium';
  }
  return 'Low';
}

/** Sorted unique list of all shelves across the given books. */
export function shelvesOf(books: Book[]): string[] {
  const shelves = new Set<string>();
  for (const book of books) {
    for (const shelf of book.shelves) {
      shelves.add(shelf);
    }
  }
  return [...shelves].sort((a, b) => a.localeCompare(b));
}

/** A fresh comparison-session id: hex, at most 32 characters. */
export function newSessionId(): string {
  let id = '';
  while (id.length < 32) {
    id += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  }
  return id.slice(0, 32);
}
