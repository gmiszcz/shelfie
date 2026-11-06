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

/** AG-UI canonical event names carried in the `agui` field of each ChatEvent. */
export type AgUiEventName =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'TEXT_MESSAGE_CONTENT'
  | 'THINKING_TEXT_MESSAGE_CONTENT'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT';

/** Which scope the chat runs in: read-only data assistant, or also UI control. */
export type ChatScope = 'library' | 'ui';

export type ChatEvent =
  | { type: 'session_start'; session_id: string; agui?: 'RUN_STARTED' }
  | { type: 'reasoning'; text: string; agui?: 'THINKING_TEXT_MESSAGE_CONTENT' }
  | { type: 'token'; text: string; agui?: 'TEXT_MESSAGE_CONTENT' }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      input: Record<string, unknown>;
      ui_action?: boolean;
      agui?: 'TOOL_CALL_START';
    }
  | {
      type: 'tool_args';
      id: string;
      name: string;
      input: Record<string, unknown>;
      ui_action?: boolean;
      agui?: 'TOOL_CALL_ARGS';
    }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      status: string;
      input?: Record<string, unknown>;
      ui_action?: boolean;
      agui?: 'TOOL_CALL_END' | 'TOOL_CALL_RESULT';
    }
  | { type: 'error'; message: string; agui?: 'RUN_ERROR' }
  | {
      type: 'session_finish';
      session_id?: string;
      text: string;
      ok: boolean;
      agui?: 'RUN_FINISHED' | 'RUN_ERROR';
    };

/**
 * UI-bus event detail (agent -> frontend), dispatched as
 * `window.dispatchEvent(new CustomEvent('shelfie:ui', { detail }))`.
 * Mirrors the wave-2 UI-bus contract; ag-ui-voice dispatches, ui-shell listens.
 */
export type UiBusDetail =
  | {
      action: 'filter_library';
      query?: string;
      series?: string;
      author?: string;
      shelf?: string;
      tag?: string;
      status?: string;
      min_stars?: number;
      book_ids?: number[];
    }
  | { action: 'navigate'; tab: 'library' | 'stats' | 'ranking' }
  | { action: 'open_book'; book_id: number }
  | { action: 'clear_filter' };

/** Event name for the agent -> frontend UI bus. */
export const UI_BUS_EVENT = 'shelfie:ui';

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
