export type ReadingStatus = 'want' | 'reading' | 'finished' | 'abandoned';

/** A metadata hit from Google Books / OpenLibrary, not yet in the library. */
export interface VolumeSearchResult {
  google_volume_id: string | null;
  title: string;
  subtitle: string | null;
  authors: string[];
  publisher: string | null;
  published_date: string | null;
  description: string | null;
  page_count: number | null;
  categories: string[];
  language: string | null;
  isbn_10: string | null;
  isbn_13: string | null;
  cover_url: string | null;
}

/** Everything the user can set on a book (POST /api/books body). Dates are YYYY-MM-DD. */
export interface BookInput {
  external_id?: string | null;
  google_volume_id?: string | null;
  title: string;
  subtitle?: string | null;
  authors?: string[];
  translators?: string[];
  publisher?: string | null;
  published_date?: string | null;
  description?: string | null;
  page_count?: number | null;
  categories?: string[];
  language?: string | null;
  isbn_10?: string | null;
  isbn_13?: string | null;
  cover_url?: string | null;
  format?: string | null;
  edition?: string | null;
  series?: string | null;
  volume?: string | null;
  status?: ReadingStatus;
  stars?: number | null;
  started_on?: string | null;
  finished_on?: string | null;
  pages_read?: number | null;
  shelves?: string[];
  tags?: string[];
  review?: string | null;
  notes?: string | null;
  quotes?: string | null;
  signed?: boolean;
  condition?: string | null;
  copies?: number;
  purchase_date?: string | null;
  purchase_price?: number | null;
  purchase_from?: string | null;
  metadata_source?: string;
}

/** Partial update (PATCH /api/books/{id}). */
export type BookPatch = Partial<Omit<BookInput, 'external_id' | 'metadata_source'>>;

export interface Book extends Required<Omit<BookInput, 'stars'>> {
  id: number;
  stars: number | null;
  latent_strength: number | null;
  rating_uncertainty: number | null;
  display_score: number | null;
  comparison_count: number;
  added_at: string;
  updated_at: string;
}

export interface SearchResponse {
  total_items: number;
  items: VolumeSearchResult[];
}

// --- stats -------------------------------------------------------------------------------

export type GroupBy = 'shelf' | 'tag' | 'month' | 'year';

export interface StatsBucket {
  key: string;
  books: number;
  pages: number;
}

export interface StatsSummary {
  books: number;
  pages: number;
  average_stars: number | null;
  first_finished: string | null;
  last_finished: string | null;
}

export interface StatsResponse {
  date_from: string | null;
  date_to: string | null;
  group_by: GroupBy;
  summary: StatsSummary;
  buckets: StatsBucket[];
  books: Book[];
}

// --- ratings -----------------------------------------------------------------------------

export type Winner = 'left' | 'right' | 'tie';

export interface RatingPair {
  left: Book;
  right: Book;
}

export interface RecomputeResult {
  rated_books: number;
  comparisons: number;
}

// --- agent chat (SSE wire protocol of POST /api/agent/chat) ------------------------------

export type ChatEvent =
  | { type: 'session_start'; session_id: string }
  | { type: 'reasoning'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; status: string }
  | { type: 'error'; message: string }
  | { type: 'session_finish'; session_id?: string; text: string; ok: boolean };

// --- labels ------------------------------------------------------------------------------

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
  abandoned: 'Abandoned',
};

export const STATUS_SEVERITY: Record<ReadingStatus, 'info' | 'warning' | 'success' | 'danger'> = {
  want: 'info',
  reading: 'warning',
  finished: 'success',
  abandoned: 'danger',
};
