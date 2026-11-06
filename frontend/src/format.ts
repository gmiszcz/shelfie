import type { VolumeSearchResult } from './types';

/** Join authors into a display string, with a fallback. */
export function formatAuthors(authors: string[]): string {
  if (authors.length === 0) {
    return 'Unknown author';
  }
  if (authors.length <= 2) {
    return authors.join(' & ');
  }
  return `${authors[0]} +${authors.length - 1}`;
}

/** Extract just the year from a Google Books published_date (YYYY, YYYY-MM, YYYY-MM-DD). */
export function formatYear(publishedDate: string | null): string {
  if (!publishedDate) {
    return '';
  }
  const match = publishedDate.match(/^(\d{4})/);
  return match ? match[1] : publishedDate;
}

/** A stable key for a search hit, even when it has no volume id. */
export function hitKey(hit: VolumeSearchResult, index: number): string {
  return hit.google_volume_id ?? `${hit.title}-${index}`;
}
