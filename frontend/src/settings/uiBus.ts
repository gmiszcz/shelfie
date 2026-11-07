import type { BookInput } from '../types';
import type { LibraryFilter } from './libraryFilter';

/** The tab ids the app bar can switch to (agent `navigate` action). */
export type UiTab = 'library' | 'stats' | 'ranking';

/** Whole-star value for the star filter (null = "Any"). */
export type StarValue = 1 | 2 | 3 | 4 | 5 | null;

/** Which add flow `open_add_book` opens. */
export type AddBookMode = 'search' | 'manual';

/**
 * Agent -> frontend UI bus events (contract v2). The agent dispatches:
 *   window.dispatchEvent(new CustomEvent('shelfie:ui', { detail }))
 * and the shell listens on the same event name. After handling an event the
 * shell dispatches a `shelfie:ui:ack` CustomEvent so the agent knows it worked.
 */
export type UiBusEvent =
  // --- v1 (still supported) ---
  | ({ action: 'filter_library' } & LibraryFilter)
  | { action: 'navigate'; tab: UiTab }
  | { action: 'open_book'; book_id: number }
  | { action: 'clear_filter' }
  // --- v2 ---
  | { action: 'set_search'; query: string }
  | { action: 'set_star_filter'; stars: StarValue }
  | {
      action: 'open_add_book';
      mode: AddBookMode;
      query?: string;
      prefill?: Partial<BookInput>;
    }
  | { action: 'open_settings' }
  | { action: 'close_dialogs' }
  | { action: 'set_setting'; key: string; value: boolean }
  | { action: 'toggle_theme' }
  | { action: 'ranking'; query: string };

/** Payload of the `shelfie:ui:ack` acknowledgement event. */
export interface UiBusAck {
  action: string;
  ok: boolean;
  info?: string;
}

export const UI_BUS_EVENT = 'shelfie:ui';
export const UI_BUS_ACK_EVENT = 'shelfie:ui:ack';

/** Read-only snapshot of the shell state, exposed on `window.__shelfieUiState`. */
export interface ShelfieUiState {
  tab: UiTab;
  search: string;
  starFilter: StarValue;
  assistantFilter: LibraryFilter | null;
  settings: unknown;
  visibleBookIds: number[];
  openDialog: 'none' | 'detail' | 'search' | 'form' | 'settings';
}

declare global {
  interface Window {
    __shelfieUiState?: Partial<ShelfieUiState>;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v);

/** Narrow an unknown CustomEvent detail into a UiBusEvent, or null if invalid. */
export function parseUiBusEvent(detail: unknown): UiBusEvent | null {
  if (!detail || typeof detail !== 'object' || !('action' in detail)) {
    return null;
  }
  const d = detail as Record<string, unknown>;
  switch (d.action) {
    case 'filter_library':
    case 'clear_filter':
    case 'open_settings':
    case 'close_dialogs':
    case 'toggle_theme':
      return detail as UiBusEvent;
    case 'navigate': {
      const tab = d.tab;
      return tab === 'library' || tab === 'stats' || tab === 'ranking'
        ? ({ action: 'navigate', tab } as UiBusEvent)
        : null;
    }
    case 'open_book':
      return isNum(d.book_id) ? ({ action: 'open_book', book_id: d.book_id } as UiBusEvent) : null;
    case 'set_search':
      return isStr(d.query) ? ({ action: 'set_search', query: d.query } as UiBusEvent) : null;
    case 'set_star_filter': {
      const s = d.stars;
      if (s === null || (isNum(s) && s >= 1 && s <= 5 && Number.isInteger(s))) {
        return { action: 'set_star_filter', stars: s as StarValue };
      }
      return null;
    }
    case 'open_add_book': {
      const mode = d.mode === 'manual' ? 'manual' : d.mode === 'search' ? 'search' : null;
      if (!mode) {
        return null;
      }
      const ev: UiBusEvent = { action: 'open_add_book', mode };
      if (isStr(d.query)) {
        ev.query = d.query;
      }
      if (d.prefill && typeof d.prefill === 'object') {
        ev.prefill = d.prefill as Partial<BookInput>;
      }
      return ev;
    }
    case 'set_setting':
      return isStr(d.key) && typeof d.value === 'boolean'
        ? ({ action: 'set_setting', key: d.key, value: d.value } as UiBusEvent)
        : null;
    case 'ranking':
      return isStr(d.query)
        ? ({ action: 'ranking', query: d.query } as UiBusEvent)
        : null;
    default:
      return null;
  }
}

/** Dispatch the `shelfie:ui:ack` acknowledgement for a handled bus event. */
export function dispatchUiAck(ack: UiBusAck): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UI_BUS_ACK_EVENT, { detail: ack }));
  }
}
