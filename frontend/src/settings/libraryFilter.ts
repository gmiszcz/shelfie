import type { Book } from '../types';

/**
 * A structured filter coming from the agent (anchors) or the in-library search
 * box. All fields are optional and combine with AND.
 *
 * Beyond the free-text / facet fields, the agent can filter by STRUCTURED time
 * facets so a request like "books I read this year" resolves to a real
 * `finished_on` year rather than a text search:
 *   - `finished_year` / `started_year` / `published_year` — a single calendar year;
 *   - `finished_from` / `finished_to` — an inclusive `finished_on` date range
 *     (YYYY-MM-DD), for sub-year or multi-year windows.
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
  finished_year?: number;
  started_year?: number;
  published_year?: number;
  finished_from?: string;
  finished_to?: string;
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
    f.finished_year == null &&
    f.started_year == null &&
    f.published_year == null &&
    !f.finished_from &&
    !f.finished_to &&
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

/** The 4-digit year at the start of an ISO-ish date string, or null. */
function yearOf(date: string | null | undefined): number | null {
  if (!date) {
    return null;
  }
  const m = /^(\d{4})/.exec(date.trim());
  return m ? Number(m[1]) : null;
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
    if (f.finished_year != null && yearOf(book.finished_on) !== f.finished_year) {
      return false;
    }
    if (f.started_year != null && yearOf(book.started_on) !== f.started_year) {
      return false;
    }
    if (f.published_year != null && yearOf(book.published_date) !== f.published_year) {
      return false;
    }
    if (f.finished_from || f.finished_to) {
      const d = book.finished_on;
      if (!d) {
        return false;
      }
      if (f.finished_from && d < f.finished_from) {
        return false;
      }
      if (f.finished_to && d > f.finished_to) {
        return false;
      }
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
  if (f.finished_year != null) parts.push(`finished ${f.finished_year}`);
  if (f.started_year != null) parts.push(`started ${f.started_year}`);
  if (f.published_year != null) parts.push(`published ${f.published_year}`);
  if (f.finished_from || f.finished_to) {
    parts.push(`finished ${f.finished_from ?? '…'}–${f.finished_to ?? '…'}`);
  }
  if (f.book_ids && f.book_ids.length > 0) parts.push(`${f.book_ids.length} books`);
  return parts.join(' · ') || 'all books';
}

/** Distinct, descending list of the years present in a date field across the books. */
function yearsFrom(books: Book[], pick: (b: Book) => string | null | undefined): number[] {
  const set = new Set<number>();
  for (const b of books) {
    const y = yearOf(pick(b));
    if (y != null) {
      set.add(y);
    }
  }
  return [...set].sort((a, b) => b - a);
}

/** Years with at least one `finished_on` book, newest first (for the anchor options). */
export const finishedYears = (books: Book[]): number[] => yearsFrom(books, (b) => b.finished_on);
/** Years with at least one `started_on` book, newest first. */
export const startedYears = (books: Book[]): number[] => yearsFrom(books, (b) => b.started_on);
/** Years with at least one `published_date` book, newest first. */
export const publishedYears = (books: Book[]): number[] => yearsFrom(books, (b) => b.published_date);

/** Distinct sorted shelves present across the books. */
export function shelvesOf(books: Book[]): string[] {
  const set = new Set<string>();
  for (const b of books) {
    for (const s of b.shelves ?? []) {
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct sorted tags present across the books. */
export function tagsOf(books: Book[]): string[] {
  const set = new Set<string>();
  for (const b of books) {
    for (const t of b.tags ?? []) {
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct sorted series present across the books. */
export function seriesOf(books: Book[]): string[] {
  const set = new Set<string>();
  for (const b of books) {
    if (b.series) set.add(b.series);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct sorted authors present across the books. */
export function authorsOf(books: Book[]): string[] {
  const set = new Set<string>();
  for (const b of books) {
    for (const a of b.authors ?? []) {
      if (a) set.add(a);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** The reading statuses a book can have (for the status anchor options). */
export const STATUS_VALUES: readonly string[] = ['want', 'reading', 'finished', 'abandoned'];
