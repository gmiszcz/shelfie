/**
 * The runtime anchor registry and the schema/act engine behind the generic
 * agent tools.
 *
 * Controls register an {@link AnchorConfig} (via {@link useAgentAnchor}) on mount
 * and unregister on unmount. The agent's generic tools call:
 *   - {@link describeUi} — build the whole UI schema from the live registry;
 *   - {@link getAnchorState} — read one anchor's value (`get_state`);
 *   - {@link setAnchor} — write one anchor's value (`set`);
 *   - {@link invokeAnchor} — run an action on one anchor (`invoke`);
 *   - {@link navigate} — a convenience wrapper over the `nav.tab` anchor.
 *
 * Everything is plain data + callbacks, with no React and no DOM beyond the
 * optional change listener, so it is unit-testable directly.
 */

import type {
  AnchorConfig,
  AnchorDescription,
  AnchorKind,
  TabDescription,
  UiSchema,
} from './types';

/** The id of the single anchor the nav registers for tab switching. */
export const NAV_TAB_ID = 'nav.tab';

/** Max list items any `list` anchor exposes in the schema (bounded output). */
export const LIST_ITEM_CAP = 50;

/** Value kinds the agent writes with `set`. */
const VALUE_KINDS: ReadonlySet<AnchorKind> = new Set<AnchorKind>([
  'text-input',
  'search',
  'select',
  'toggle',
  'multi-select',
]);

/** A static tab entry, so a tab is described even before it has mounted. */
export interface StaticTab {
  id: string;
  label: string;
}

/** The live registry. Latest registration for an id wins (controls are unique). */
const registry = new Map<string, AnchorConfig>();

/** The static tab list, seeded once from the nav. */
let staticTabs: StaticTab[] = [];

/** The active tab id, kept current by the nav. */
let activeTab: string | null = null;

/** Change listeners (the agent snapshot on `window` is refreshed on any change). */
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a listener must never break the registry
    }
  }
}

/** Subscribe to registry changes (register/unregister/active-tab). Returns an unsubscribe. */
export function onRegistryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Register (or replace) an anchor. Returns an unregister function. */
export function registerAnchor(config: AnchorConfig): () => void {
  registry.set(config.id, config);
  emitChange();
  return () => {
    // Only delete if this exact config is still the registered one (guards against
    // a fast remount having already replaced it).
    if (registry.get(config.id) === config) {
      registry.delete(config.id);
      emitChange();
    }
  };
}

/** Seed the static tab list (called once by the nav). */
export function setStaticTabs(tabs: StaticTab[]): void {
  staticTabs = tabs.slice();
  emitChange();
}

/** Record which tab is active (called by the nav when it changes). */
export function setActiveTab(tab: string | null): void {
  if (activeTab !== tab) {
    activeTab = tab;
    emitChange();
  }
}

/** The active tab id, or null before the nav has reported one. */
export function getActiveTab(): string | null {
  return activeTab;
}

/** Test-only: clear all registry state. */
export function _resetRegistry(): void {
  registry.clear();
  staticTabs = [];
  activeTab = null;
  listeners.clear();
}

/** Look up a live anchor by id. */
export function getAnchor(id: string): AnchorConfig | undefined {
  return registry.get(id);
}

/** All registered anchor ids (for error messages). */
export function anchorIds(): string[] {
  return [...registry.keys()].sort();
}

/** Describe one anchor for the schema (reads value / options / items live). */
function describeAnchor(config: AnchorConfig): AnchorDescription {
  const out: AnchorDescription = {
    id: config.id,
    kind: config.kind,
    label: config.label,
  };
  if (config.description) {
    out.description = config.description;
  }
  if (config.tab) {
    out.tab = config.tab;
  }
  if (config.getState) {
    try {
      out.value = config.getState();
    } catch {
      out.value = null;
    }
  }
  if (config.options) {
    try {
      out.options = config.options();
    } catch {
      out.options = [];
    }
  }
  if (config.actions && config.actions.length) {
    out.actions = config.actions.slice();
  }
  if (VALUE_KINDS.has(config.kind) && typeof config.set === 'function') {
    out.settable = true;
  }
  if (config.kind === 'list' && config.items) {
    try {
      out.items = config.items().slice(0, LIST_ITEM_CAP);
    } catch {
      out.items = [];
    }
  }
  return out;
}

/**
 * Build the whole UI schema from the live registry.
 *
 * Tabs come from the static nav list (so an unmounted tab is still listed); each
 * tab collects the anchors whose `tab` matches its id. Anchors with no `tab`
 * (nav, theme, settings) go to `global`. The `nav.tab` anchor itself is global.
 */
export function describeUi(): UiSchema {
  const anchors = [...registry.values()];
  const byTab = new Map<string, AnchorDescription[]>();
  const global: AnchorDescription[] = [];

  for (const config of anchors) {
    const described = describeAnchor(config);
    if (config.tab) {
      const list = byTab.get(config.tab) ?? [];
      list.push(described);
      byTab.set(config.tab, list);
    } else {
      global.push(described);
    }
  }

  // Tabs that have anchors but are not in the static list still get described.
  const tabIds = new Set<string>(staticTabs.map((t) => t.id));
  for (const id of byTab.keys()) {
    tabIds.add(id);
  }

  const labelFor = (id: string): string =>
    staticTabs.find((t) => t.id === id)?.label ?? id;

  const tabs: TabDescription[] = [...tabIds].map((id) => {
    const tabAnchors = byTab.get(id) ?? [];
    return {
      id,
      label: labelFor(id),
      active: activeTab === id,
      mounted: tabAnchors.length > 0,
      anchors: tabAnchors.sort((a, b) => a.id.localeCompare(b.id)),
    };
  });

  // Keep the static nav order, then any extra tabs alphabetically.
  tabs.sort((a, b) => {
    const ia = staticTabs.findIndex((t) => t.id === a.id);
    const ib = staticTabs.findIndex((t) => t.id === b.id);
    if (ia === -1 && ib === -1) return a.id.localeCompare(b.id);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return {
    activeTab,
    tabs,
    global: global.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Result of a generic act (`set` / `invoke` / `navigate`). */
export interface ActResult {
  ok: boolean;
  id?: string;
  value?: unknown;
  error?: string;
  /** On an error, the valid ids or option values to help the model recover. */
  valid?: string[];
}

/** Read one anchor's current value (`get_state`). */
export function getAnchorState(id: string): ActResult {
  const anchor = registry.get(id);
  if (!anchor) {
    return { ok: false, error: `unknown id "${id}"`, valid: anchorIds() };
  }
  if (!anchor.getState) {
    return { ok: false, id, error: `"${id}" has no readable state` };
  }
  try {
    return { ok: true, id, value: anchor.getState() };
  } catch (err) {
    return { ok: false, id, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Validate a value against a select / multi-select anchor's options. */
function validateAgainstOptions(anchor: AnchorConfig, value: unknown): ActResult | null {
  if (!anchor.options) {
    return null;
  }
  const opts = anchor.options();
  const allowed = new Set(opts.map((o) => o.value));
  const values = anchor.kind === 'multi-select' && Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (v == null) {
      continue;
    }
    if (!allowed.has(String(v))) {
      return {
        ok: false,
        id: anchor.id,
        error: `"${String(v)}" is not an allowed value for "${anchor.id}"`,
        valid: opts.map((o) => o.value),
      };
    }
  }
  return null;
}

/** Write one anchor's value (`set`). Validates against options when present. */
export async function setAnchor(id: string, value: unknown): Promise<ActResult> {
  const anchor = registry.get(id);
  if (!anchor) {
    return { ok: false, error: `unknown id "${id}"`, valid: anchorIds() };
  }
  if (!VALUE_KINDS.has(anchor.kind) || typeof anchor.set !== 'function') {
    return {
      ok: false,
      id,
      error: `"${id}" (${anchor.kind}) cannot be set; use invoke instead`,
    };
  }
  const invalid = validateAgainstOptions(anchor, value);
  if (invalid) {
    return invalid;
  }
  try {
    await anchor.set(value);
    return { ok: true, id, value };
  } catch (err) {
    return { ok: false, id, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run an action on one anchor (`invoke`). */
export async function invokeAnchor(
  id: string,
  action?: string,
  args?: Record<string, unknown>,
): Promise<ActResult> {
  const anchor = registry.get(id);
  if (!anchor) {
    return { ok: false, error: `unknown id "${id}"`, valid: anchorIds() };
  }
  if (typeof anchor.invoke !== 'function') {
    return { ok: false, id, error: `"${id}" cannot be invoked` };
  }
  if (action && anchor.actions && anchor.actions.length && !anchor.actions.includes(action)) {
    return {
      ok: false,
      id,
      error: `"${action}" is not a valid action for "${id}"`,
      valid: anchor.actions.slice(),
    };
  }
  try {
    await anchor.invoke(action, args);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, id, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Switch the active tab through the `nav.tab` anchor (`navigate`). */
export async function navigate(tab: string): Promise<ActResult> {
  const nav = registry.get(NAV_TAB_ID);
  const known = new Set(staticTabs.map((t) => t.id));
  if (known.size && !known.has(tab)) {
    return {
      ok: false,
      error: `unknown tab "${tab}"`,
      valid: [...known],
    };
  }
  if (!nav || typeof nav.invoke !== 'function') {
    return { ok: false, error: 'navigation is not available yet', valid: [...known] };
  }
  try {
    await nav.invoke('navigate', { tab });
    return { ok: true, id: NAV_TAB_ID, value: tab };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
