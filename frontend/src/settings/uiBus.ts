import type { LibraryFilter } from './libraryFilter';

/** The tab ids the app bar can switch to (agent `navigate` action). */
export type UiTab = 'library' | 'stats' | 'ranking';

/**
 * Agent -> frontend UI bus events (contract 3). The agent dispatches:
 *   window.dispatchEvent(new CustomEvent('shelfie:ui', { detail }))
 * and the shell listens on the same event name.
 */
export type UiBusEvent =
  | ({ action: 'filter_library' } & LibraryFilter)
  | { action: 'navigate'; tab: UiTab }
  | { action: 'open_book'; book_id: number }
  | { action: 'clear_filter' };

export const UI_BUS_EVENT = 'shelfie:ui';

/** Narrow an unknown CustomEvent detail into a UiBusEvent, or null if invalid. */
export function parseUiBusEvent(detail: unknown): UiBusEvent | null {
  if (!detail || typeof detail !== 'object' || !('action' in detail)) {
    return null;
  }
  const d = detail as { action: unknown };
  switch (d.action) {
    case 'filter_library':
    case 'clear_filter':
      return detail as UiBusEvent;
    case 'navigate': {
      const tab = (detail as { tab?: unknown }).tab;
      return tab === 'library' || tab === 'stats' || tab === 'ranking'
        ? ({ action: 'navigate', tab } as UiBusEvent)
        : null;
    }
    case 'open_book': {
      const id = (detail as { book_id?: unknown }).book_id;
      return typeof id === 'number' ? ({ action: 'open_book', book_id: id } as UiBusEvent) : null;
    }
    default:
      return null;
  }
}
