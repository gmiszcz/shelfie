import type { Book } from '../types';

/**
 * A structured filter coming from the agent UI bus (contract 3) or the
 * in-library search box. All fields are optional and combine with AND.
 */
export interface LibraryFilter {
  query?: string;
  series?: string;
  author?: string;
  shelf?: string;
  tag?: string;
  status?: string;
  min_stars?: number;
  book_ids?: number[];
}

/** True when the filter has no active constraint. */
export function isEmptyFilter(f: LibraryFilter | null | undefined): boolean {
  if (!f) {
    return true;
  }
  return (
    !f.query?.trim() &&
    !f.series &&
    !f.author &&
    !f.shelf &&
    !f.tag &&
    !f.status &&
    f.min_stars == null &&
    (f.book_ids == null || f.book_ids.length === 0)
  );
}

function matchesQuery(book: Book, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const haystack = [
    book.title,
    book.subtitle ?? '',
    book.series ?? '',
    ...book.authors,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function includesCI(values: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return values.some((v) => v.toLowerCase() === n);
}

/** Apply a filter to the book list; empty filter returns the list unchanged. */
export function applyFilter(books: Book[], filter: LibraryFilter | null | undefined): Book[] {
  if (isEmptyFilter(filter)) {
    return books;
  }
  const f = filter as LibraryFilter;
  const ids = f.book_ids && f.book_ids.length > 0 ? new Set(f.book_ids) : null;

  return books.filter((book) => {
    if (ids && !ids.has(book.id)) {
      return false;
    }
    if (f.query && !matchesQuery(book, f.query)) {
      return false;
    }
    if (f.series && (book.series ?? '').toLowerCase() !== f.series.toLowerCase()) {
      return false;
    }
    if (f.author && !includesCI(book.authors, f.author)) {
      return false;
    }
    if (f.shelf && !includesCI(book.shelves, f.shelf)) {
      return false;
    }
    if (f.tag && !includesCI(book.tags, f.tag)) {
      return false;
    }
    if (f.status && book.status !== f.status) {
      return false;
    }
    if (f.min_stars != null && !((book.stars ?? 0) >= f.min_stars)) {
      return false;
    }
    return true;
  });
}

/** One-line human summary of an active assistant filter, for the chip label. */
export function describeFilter(f: LibraryFilter): string {
  const parts: string[] = [];
  if (f.query?.trim()) parts.push(`"${f.query.trim()}"`);
  if (f.series) parts.push(`series: ${f.series}`);
  if (f.author) parts.push(`author: ${f.author}`);
  if (f.shelf) parts.push(`shelf: ${f.shelf}`);
  if (f.tag) parts.push(`tag: ${f.tag}`);
  if (f.status) parts.push(`status: ${f.status}`);
  if (f.min_stars != null) parts.push(`${f.min_stars}+ stars`);
  if (f.book_ids && f.book_ids.length > 0) parts.push(`${f.book_ids.length} books`);
  return parts.join(' · ') || 'all books';
}
