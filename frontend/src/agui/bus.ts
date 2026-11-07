/**
 * UI bus contract **v2** (agent ↔ frontend), owned by ui-agent.
 *
 * The browser-side agent's tools drive the app by dispatching a
 * `window` CustomEvent `'shelfie:ui'` whose `detail` is one of {@link UiBusDetail}.
 * A listener (owned by library-fixes / App) handles it and MUST answer with a
 * `'shelfie:ui:ack'` CustomEvent carrying {@link UiAck} so a tool can wait for the
 * effect and report back to the model.
 *
 * A read-only snapshot of the UI is exposed on `window.__shelfieUiState`
 * ({@link ShelfieUiState}); ui-agent only reads it.
 *
 * This module is pure DOM plumbing — no React, so it is unit-testable with jsdom.
 */

import type { ShelfieUiState as ShellUiState } from '../settings/uiBus';

/** The tab ids the app bar can switch to. */
export type UiTab = 'library' | 'stats' | 'ranking';

/** Whole-star filter value (1..5) or `null` to clear it. */
export type StarFilterValue = 1 | 2 | 3 | 4 | 5 | null;

/** Everything the agent can set when adding a book. Mirrors a partial BookInput. */
export interface AddBookPrefill {
  title?: string;
  authors?: string[];
  series?: string;
  [key: string]: unknown;
}

/**
 * One UI-bus action (CustomEvent `shelfie:ui` `detail`). Covers the v1 events
 * (filter_library / clear_filter / navigate / open_book) and the v2 additions.
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
  | { action: 'clear_filter' }
  | { action: 'navigate'; tab: UiTab }
  | { action: 'open_book'; book_id: number }
  | { action: 'set_search'; query: string }
  | { action: 'set_star_filter'; stars: StarFilterValue }
  | { action: 'open_add_book'; mode: 'search' | 'manual'; query?: string; prefill?: AddBookPrefill }
  | { action: 'open_settings' }
  | { action: 'close_dialogs' }
  | { action: 'set_setting'; key: string; value: boolean }
  | { action: 'toggle_theme' }
  | { action: 'ranking'; rankingAction: 'search'; query: string };

/** The ack a listener dispatches on `shelfie:ui:ack` after handling an action. */
export interface UiAck {
  action: UiBusDetail['action'];
  ok: boolean;
  info?: string;
}

/**
 * Read-only UI-state snapshot exposed on `window.__shelfieUiState`.
 * The shell (settings/uiBus.ts) owns the full type and the global declaration; the agent
 * only ever reads it and must tolerate missing fields.
 */
export type ShelfieUiState = Partial<ShellUiState>;

export const UI_BUS_EVENT = 'shelfie:ui';
export const UI_BUS_ACK_EVENT = 'shelfie:ui:ack';

/** Read the current UI state snapshot, or an empty object when none is exposed. */
export function readUiState(): ShelfieUiState {
  if (typeof window === 'undefined') {
    return {};
  }
  return window.__shelfieUiState ?? {};
}

/**
 * Dispatch a UI action and wait for the matching `shelfie:ui:ack`.
 *
 * Resolves with the ack (`{ ok, info }`) when a listener answers for the same
 * `action`, or with a synthetic `{ ok: true, info: 'no ack' }` after `timeoutMs`
 * when no listener acks (so a missing listener degrades to "assume done" rather
 * than hanging the agent loop). Returns `{ ok: false }` only when there is no
 * `window` at all.
 */
export function dispatchAndWait(detail: UiBusDetail, timeoutMs = 1500): Promise<UiAck> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ action: detail.action, ok: false, info: 'no window' });
  }
  return new Promise<UiAck>((resolve) => {
    let settled = false;
    const finish = (ack: UiAck) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener(UI_BUS_ACK_EVENT, onAck as EventListener);
      clearTimeout(timer);
      resolve(ack);
    };
    const onAck = (e: Event) => {
      const ack = (e as CustomEvent).detail as UiAck | undefined;
      if (ack && ack.action === detail.action) {
        finish(ack);
      }
    };
    window.addEventListener(UI_BUS_ACK_EVENT, onAck as EventListener);
    const timer = setTimeout(
      () => finish({ action: detail.action, ok: true, info: 'no ack (timeout)' }),
      timeoutMs,
    );
    window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  });
}

/** Dispatch a UI action without waiting for an ack (fire-and-forget). */
export function dispatch(detail: UiBusDetail): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UI_BUS_EVENT, { detail }));
  }
}
