export type ReadingStatus = 'want' | 'reading' | 'finished' | 'abandoned';

export interface Book {
  id: number;
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
  status: ReadingStatus;
  stars: number | null;
  added_at: string;
  updated_at: string;
}

/** A Google Books search hit, not yet persisted (same metadata shape, no id/status). */
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

export interface SearchResponse {
  total_items: number;
  items: VolumeSearchResult[];
}

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
