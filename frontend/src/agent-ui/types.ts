/**
 * Universal agent-UI registry — type contract.
 *
 * The browser-side AG-UI agent used to drive the app through a hand-written tool
 * per action (`set_search`, `set_star_filter`, `navigate`, …) and a matching case
 * in the UI bus. Adding a tab meant editing the agent. This module replaces that
 * with a **runtime registry of anchors**: every interactive control declares
 * itself with {@link useAgentAnchor}, and the agent discovers the whole UI from
 * the live registry via {@link describeUi} — no agent-side code or database.
 *
 * An anchor is one addressable control. Its {@link AnchorKind} tells the agent
 * what it is and which generic verb applies:
 *   - a value control (`text-input`, `search`, `select`, `toggle`, `multi-select`)
 *     is read with `get_state` and written with `set`;
 *   - an action control (`button`, `tab`, `dialog`) is driven with `invoke`;
 *   - a `list` exposes its items (bounded) so the agent can `invoke` one.
 *
 * Ids are **stable dotted paths** (`library.search`, `nav.tab`,
 * `settings.cardFields.author`, `ranking.category`, `stats.period`). A tab
 * registers a single `tab`-kind anchor so an unmounted tab's controls are still
 * described (the schema records which tab owns which anchor), and the static tab
 * list from the nav is always present even before a tab has mounted.
 *
 * This file is pure types + no React, so the registry and `describeUi` are
 * unit-testable with plain data.
 */

/** The kind of control an anchor represents. Drives which generic verb applies. */
export type AnchorKind =
  | 'tab'
  | 'text-input'
  | 'search'
  | 'select'
  | 'toggle'
  | 'multi-select'
  | 'button'
  | 'list'
  | 'dialog';

/** One selectable option for a `select` / `multi-select` anchor. */
export interface AnchorOption {
  value: string;
  label: string;
}

/** One item of a `list` anchor (e.g. a visible book), so the agent can open it. */
export interface AnchorListItem {
  id: string | number;
  title: string;
}

/**
 * An anchor registration. A control passes this to {@link useAgentAnchor}; the
 * registry keeps the live set and {@link describeUi} reads it.
 *
 * `getState`, `set`, `invoke` and `options` are read live at describe/act time so
 * the schema always reflects the current UI, never a stale snapshot.
 */
export interface AnchorConfig {
  /** Stable dotted path, unique while mounted. E.g. `library.search`. */
  id: string;
  /** What kind of control this is. */
  kind: AnchorKind;
  /** Short human label shown to the model (and in action cards). */
  label: string;
  /** Optional longer hint for the model about what the control does. */
  description?: string;
  /**
   * The tab this anchor belongs to (a `nav.tab` value such as `library`), or
   * omitted for app-global anchors (nav, theme, settings). Lets the schema group
   * anchors by tab even when the owning tab is not mounted.
   */
  tab?: string;
  /** Read the control's current value (any JSON-able value), live. */
  getState?: () => unknown;
  /** Set the control's value (for value kinds). Return/throw is ignored; errors are caught. */
  set?: (value: unknown) => void | Promise<void>;
  /**
   * Run an action on the control. `action` names the sub-action for a control
   * with several (e.g. a dialog's `open` / `close`); `args` carries parameters
   * (e.g. a list item id to open). Value controls usually omit this.
   */
  invoke?: (action?: string, args?: Record<string, unknown>) => void | Promise<void>;
  /** Allowed values for a `select` / `multi-select`, read live. */
  options?: () => AnchorOption[];
  /** The items of a `list` anchor, read live (the registry bounds how many it exposes). */
  items?: () => AnchorListItem[];
  /** The action names `invoke` accepts, for the schema (e.g. `['open', 'close']`). */
  actions?: string[];
}

/** One anchor as described to the model in the UI schema. */
export interface AnchorDescription {
  id: string;
  kind: AnchorKind;
  label: string;
  description?: string;
  tab?: string;
  /** The control's current value, when it exposes `getState`. */
  value?: unknown;
  /** Allowed values for a select / multi-select. */
  options?: AnchorOption[];
  /** The action names `invoke` accepts. */
  actions?: string[];
  /** Whether the control can be written with `set`. */
  settable?: boolean;
  /** List items (bounded), for a `list` anchor. */
  items?: AnchorListItem[];
  /** The full option count when `options` was capped (so the model knows more exist). */
  optionsTotal?: number;
  /** A short hint added when a field was truncated (e.g. "use find_books for others"). */
  note?: string;
}

/** One tab in the UI schema: its id/label and the anchors it owns. */
export interface TabDescription {
  id: string;
  label: string;
  /** True when this tab is the active one. */
  active: boolean;
  /** True when the tab's own controls are currently mounted (anchors live). */
  mounted: boolean;
  anchors: AnchorDescription[];
}

/** The whole UI schema `describe_ui` returns to the agent. */
export interface UiSchema {
  /** The active tab id. */
  activeTab: string | null;
  /** Every tab (from the static nav list), each with its owned anchors. */
  tabs: TabDescription[];
  /** App-global anchors not owned by any tab (nav, theme, settings sidebar). */
  global: AnchorDescription[];
}
