import { UI_BUS_EVENT, type UiBusDetail } from '../types';

/**
 * The agent -> frontend UI bus (AG-UI style).
 *
 * When the agent calls a frontend ("UI") tool, the backend streams it as an
 * AG-UI `TOOL_CALL_RESULT` event with `ui_action: true` and the tool's
 * arguments in `input`. This module turns those arguments into the
 * `shelfie:ui` CustomEvent that ui-shell listens for, and into a short
 * human-readable label shown on the "Action" card in the chat.
 */

/** The UI tools the agent may call; the bus only acts on these. */
export const UI_TOOL_NAMES = ['filter_library', 'clear_filter', 'navigate', 'open_book'] as const;
export type UiToolName = (typeof UI_TOOL_NAMES)[number];

export function isUiTool(name: string): name is UiToolName {
  return (UI_TOOL_NAMES as readonly string[]).includes(name);
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && !Number.isNaN(v) ? v : undefined;

/**
 * Build the `shelfie:ui` detail for a UI tool call, or `null` when the tool
 * name or its arguments are not usable. Pure — no dispatch, so it is unit-testable.
 */
export function toUiBusDetail(
  name: string,
  input: Record<string, unknown> | undefined,
): UiBusDetail | null {
  const args = input ?? {};
  switch (name) {
    case 'clear_filter':
      return { action: 'clear_filter' };
    case 'navigate': {
      const tab = str(args.tab);
      if (tab === 'library' || tab === 'stats' || tab === 'ranking') {
        return { action: 'navigate', tab };
      }
      return null;
    }
    case 'open_book': {
      const bookId = num(args.book_id);
      return bookId != null ? { action: 'open_book', book_id: bookId } : null;
    }
    case 'filter_library': {
      const detail: Record<string, unknown> = { action: 'filter_library' };
      for (const key of ['query', 'series', 'author', 'shelf', 'tag', 'status']) {
        const value = str(args[key]);
        if (value !== undefined) {
          detail[key] = value;
        }
      }
      const minStars = num(args.min_stars);
      if (minStars != null && minStars > 0) {
        detail.min_stars = minStars;
      }
      return detail as UiBusDetail;
    }
    default:
      return null;
  }
}

/** A short, human-readable description of a UI action for the chat "Action" card. */
export function describeUiAction(detail: UiBusDetail): string {
  switch (detail.action) {
    case 'clear_filter':
      return 'cleared the library filter';
    case 'navigate':
      return `switched to the ${detail.tab} tab`;
    case 'open_book':
      return `opened book #${detail.book_id}`;
    case 'filter_library': {
      const parts: string[] = [];
      if (detail.series) parts.push(`series ${detail.series}`);
      if (detail.author) parts.push(`author ${detail.author}`);
      if (detail.shelf) parts.push(`shelf ${detail.shelf}`);
      if (detail.tag) parts.push(`tag ${detail.tag}`);
      if (detail.status) parts.push(`status ${detail.status}`);
      if (detail.query) parts.push(`"${detail.query}"`);
      if (detail.min_stars) parts.push(`min ${detail.min_stars}★`);
      return parts.length ? `filtered library by ${parts.join(', ')}` : 'filtered the library';
    }
  }
}

/** Dispatch a UI tool call onto the `shelfie:ui` bus. Returns the detail, or null. */
export function dispatchUiAction(
  name: string,
  input: Record<string, unknown> | undefined,
): UiBusDetail | null {
  const detail = toUiBusDetail(name, input);
  if (detail && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  }
  return detail;
}
