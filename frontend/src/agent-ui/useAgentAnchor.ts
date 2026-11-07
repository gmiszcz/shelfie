/**
 * `useAgentAnchor` — the one call a control makes to become discoverable and
 * drivable by the universal UI agent.
 *
 * A control passes its stable id, kind, label and the live accessors
 * (`getState`, `set`, `invoke`, `options`, `items`). The hook registers the
 * anchor on mount and unregisters it on unmount, so the registry always reflects
 * the mounted UI. The display fields and the callback bodies are read live from a
 * ref, so a control may pass inline closures and changing labels without
 * re-registering on every render. The anchor is re-registered only when its
 * identity (`id` / `kind`) or the *set* of capabilities it exposes changes — so
 * the registry can tell a settable control from a read-only one by whether `set`
 * is present, not by guessing.
 *
 * Usage (one line per control, the only agent-facing code a component needs):
 *
 *   useAgentAnchor({
 *     id: 'library.search',
 *     kind: 'search',
 *     label: 'Library search',
 *     tab: 'library',
 *     getState: () => query,
 *     set: (v) => setQuery(String(v ?? '')),
 *   });
 */

import { useEffect, useRef } from 'react';

import { registerAnchor } from './registry';
import type { AnchorConfig } from './types';

export function useAgentAnchor(config: AnchorConfig): void {
  // Keep the latest config (display fields AND closures) in a ref so the
  // registered anchor always reflects the current render without re-registering.
  const ref = useRef(config);
  ref.current = config;

  const { id, kind } = config;
  // A capability fingerprint: which optional callbacks the config provides. Only
  // a change here (or to id/kind) re-registers, so the registry's presence-based
  // capability checks stay correct without re-registering on every render.
  const caps =
    (config.getState ? 1 : 0) |
    (config.set ? 2 : 0) |
    (config.invoke ? 4 : 0) |
    (config.options ? 8 : 0) |
    (config.items ? 16 : 0);

  useEffect(() => {
    const anchor: AnchorConfig = {
      id,
      kind,
      get label() {
        return ref.current.label;
      },
      get description() {
        return ref.current.description;
      },
      get tab() {
        return ref.current.tab;
      },
      get actions() {
        return ref.current.actions;
      },
    };
    if (caps & 1) anchor.getState = () => ref.current.getState?.();
    if (caps & 2) anchor.set = (value) => ref.current.set?.(value);
    if (caps & 4) anchor.invoke = (action, args) => ref.current.invoke?.(action, args);
    if (caps & 8) anchor.options = () => ref.current.options?.() ?? [];
    if (caps & 16) anchor.items = () => ref.current.items?.() ?? [];

    const unregister = registerAnchor(anchor);
    return unregister;
    // Re-register only on identity or capability-set change; bodies read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, caps]);
}
