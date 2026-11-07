/**
 * Shared UI vocabulary used across pages.
 *
 * This module used to own the agent↔frontend UI-bus event contract (v2). The UI
 * agent is now **universal** and drives the app through the runtime anchor
 * registry (`frontend/src/agent-ui/`), so the bus events, the `shelfie:ui`
 * CustomEvent plumbing and the `window.__shelfieUiState` snapshot are gone. Only
 * the two small shared types the pages still reference remain here.
 */

/** The tab ids the app bar can switch to. */
export type UiTab = 'library' | 'stats' | 'ranking';

/** Whole-star filter value (1..5) or `null` to clear it. */
export type StarValue = 1 | 2 | 3 | 4 | 5 | null;
