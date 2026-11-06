import type { Book } from './types';

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
