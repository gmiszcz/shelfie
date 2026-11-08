/**
 * Visual feedback for actions the UI AGENT performs (never for the user's own clicks).
 *
 * The browser tools (`agui/tools.ts`) call `emitAgentFx` after a successful `set`,
 * `invoke` or `navigate`. `AgentFxLayer` (mounted once in App) listens and:
 *   - navigate: plays a short slide-in on the main area;
 *   - set / invoke: adds a soft glow to the control the agent changed, found by
 *     `data-agent-anchor="<anchor id>"` (falls back to the tab's main list, then
 *     to the main area), and shows a small "Assistant: …" chip for ~2 s.
 * User clicks never go through these tools, so they never animate.
 * `prefers-reduced-motion` turns motion off (a static outline is kept).
 */

export type AgentFxKind = 'navigate' | 'set' | 'invoke';

export interface AgentFxDetail {
  kind: AgentFxKind;
  /** Anchor id for set/invoke, tab id for navigate. */
  target: string;
  /** Short human label of what was done (from agui/labels describeAction). */
  label: string;
}

export const AGENT_FX_EVENT = 'shelfie:agent-fx';

export function emitAgentFx(detail: AgentFxDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AgentFxDetail>(AGENT_FX_EVENT, { detail }));
}

/** The element to highlight for an anchor id (exact, then the tab's list, then main). */
export function findAnchorElement(id: string, root: ParentNode = document): HTMLElement | null {
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const exact = root.querySelector<HTMLElement>(`[data-agent-anchor="${esc(id)}"]`);
  if (exact) return exact;
  const tab = id.split('.')[0];
  const list =
    root.querySelector<HTMLElement>(`[data-agent-anchor="${esc(`${tab}.books`)}"]`) ??
    root.querySelector<HTMLElement>(`[data-agent-anchor="${esc(`${tab}.list`)}"]`);
  if (list) return list;
  return root.querySelector<HTMLElement>('.app-main');
}
