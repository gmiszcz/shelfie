import type { BookInput, ReadingStatus } from './types';

/**
 * Editable form state for the whole BookInput contract. It is deliberately
 * "wide": every field the backend accepts is present and non-optional so the
 * dialog can bind controls without undefined checks. Lists are always arrays,
 * dates are `Date | null` (for the Calendar control) and numbers are
 * `number | null` (for InputNumber). Conversion back to the API shape happens
 * in `toInput`.
 */
export interface FormState {
  title: string;
  subtitle: string;
  authors: string[];
  translators: string[];
  publisher: string;
  published_date: string;
  description: string;
  page_count: number | null;
  categories: string[];
  language: string;
  isbn_10: string;
  isbn_13: string;
  cover_url: string | null;
  format: string;
  edition: string;
  series: string;
  volume: string;
  status: ReadingStatus;
  stars: number | null;
  started_on: Date | null;
  finished_on: Date | null;
  pages_read: number | null;
  shelves: string[];
  tags: string[];
  review: string;
  notes: string;
  quotes: string;
  signed: boolean;
  condition: string;
  copies: number | null;
  purchase_date: Date | null;
  purchase_price: number | null;
  purchase_from: string;
}

/** The empty form — a brand-new manual book. */
export function emptyForm(): FormState {
  return {
    title: '',
    subtitle: '',
    authors: [],
    translators: [],
    publisher: '',
    published_date: '',
    description: '',
    page_count: null,
    categories: [],
    language: '',
    isbn_10: '',
    isbn_13: '',
    cover_url: null,
    format: '',
    edition: '',
    series: '',
    volume: '',
    status: 'want',
    stars: null,
    started_on: null,
    finished_on: null,
    pages_read: null,
    shelves: [],
    tags: [],
    review: '',
    notes: '',
    quotes: '',
    signed: false,
    condition: '',
    copies: 1,
    purchase_date: null,
    purchase_price: null,
    purchase_from: '',
  };
}

function str(value: string | null | undefined): string {
  return value == null ? '' : value;
}

function list(value: string[] | null | undefined): string[] {
  return value == null ? [] : [...value];
}

/** Parse a `YYYY-MM-DD` (or ISO) string into a local-time Date, or null. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Hydrate a form from an existing book or a partial prefill. */
export function fromBook(book: Partial<BookInput> | null | undefined): FormState {
  const base = emptyForm();
  if (!book) {
    return base;
  }
  return {
    ...base,
    title: str(book.title),
    subtitle: str(book.subtitle),
    authors: list(book.authors),
    translators: list(book.translators),
    publisher: str(book.publisher),
    published_date: str(book.published_date),
    description: str(book.description),
    page_count: book.page_count ?? null,
    categories: list(book.categories),
    language: str(book.language),
    isbn_10: str(book.isbn_10),
    isbn_13: str(book.isbn_13),
    cover_url: book.cover_url ?? null,
    format: str(book.format),
    edition: str(book.edition),
    series: str(book.series),
    volume: str(book.volume),
    status: book.status ?? 'want',
    stars: book.stars ?? null,
    started_on: parseDate(book.started_on),
    finished_on: parseDate(book.finished_on),
    pages_read: book.pages_read ?? null,
    shelves: list(book.shelves),
    tags: list(book.tags),
    review: str(book.review),
    notes: str(book.notes),
    quotes: str(book.quotes),
    signed: book.signed ?? false,
    condition: str(book.condition),
    copies: book.copies ?? 1,
    purchase_date: parseDate(book.purchase_date),
    purchase_price: book.purchase_price ?? null,
    purchase_from: str(book.purchase_from),
  };
}

/** Format a Date as a local-time `YYYY-MM-DD` string (never UTC). */
export function toLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Trim a string and collapse an empty result to null. */
function trimOrNull(value: string): string | null {
  const t = value.trim();
  return t === '' ? null : t;
}

/** Trim every entry of a list and drop the blanks. */
function cleanList(value: string[]): string[] {
  return value.map((v) => v.trim()).filter((v) => v !== '');
}

/** Convert the form into a BookInput payload for create/update. */
export function toInput(f: FormState): BookInput {
  return {
    title: f.title.trim(),
    subtitle: trimOrNull(f.subtitle),
    authors: cleanList(f.authors),
    translators: cleanList(f.translators),
    publisher: trimOrNull(f.publisher),
    published_date: trimOrNull(f.published_date),
    description: trimOrNull(f.description),
    page_count: f.page_count,
    categories: cleanList(f.categories),
    language: trimOrNull(f.language),
    isbn_10: trimOrNull(f.isbn_10),
    isbn_13: trimOrNull(f.isbn_13),
    cover_url: f.cover_url,
    format: trimOrNull(f.format),
    edition: trimOrNull(f.edition),
    series: trimOrNull(f.series),
    volume: trimOrNull(f.volume),
    status: f.status,
    stars: f.stars,
    started_on: f.started_on ? toLocalDate(f.started_on) : null,
    finished_on: f.finished_on ? toLocalDate(f.finished_on) : null,
    pages_read: f.pages_read,
    shelves: cleanList(f.shelves),
    tags: cleanList(f.tags),
    review: trimOrNull(f.review),
    notes: trimOrNull(f.notes),
    quotes: trimOrNull(f.quotes),
    signed: f.signed,
    condition: trimOrNull(f.condition),
    copies: f.copies ?? 1,
    purchase_date: f.purchase_date ? toLocalDate(f.purchase_date) : null,
    purchase_price: f.purchase_price,
    purchase_from: trimOrNull(f.purchase_from),
  };
}

/**
 * Validate the form. Returns a map of field name -> error message; an empty
 * object means the form is valid. Mirrors the backend constraints in
 * app/schemas/books.py so the user sees errors before the request.
 */
export function validate(f: FormState): Record<string, string> {
  const errors: Record<string, string> = {};

  const title = f.title.trim();
  if (title === '') {
    errors.title = 'Title is required.';
  } else if (title.length > 500) {
    errors.title = 'Title must be at most 500 characters.';
  }

  if (f.stars != null && (f.stars < 0.5 || f.stars > 5)) {
    errors.stars = 'Rating must be between 0.5 and 5.';
  }

  if (f.started_on && f.finished_on && f.finished_on < f.started_on) {
    errors.finished_on = 'Finished date cannot be before the started date.';
  }

  if (f.page_count != null && f.page_count < 0) {
    errors.page_count = 'Page count cannot be negative.';
  }
  if (f.pages_read != null && f.pages_read < 0) {
    errors.pages_read = 'Pages read cannot be negative.';
  }
  if (f.copies != null && f.copies < 0) {
    errors.copies = 'Copies cannot be negative.';
  }
  if (f.purchase_price != null && f.purchase_price < 0) {
    errors.purchase_price = 'Purchase price cannot be negative.';
  }

  return errors;
}
