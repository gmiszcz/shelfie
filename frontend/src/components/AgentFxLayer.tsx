import { useEffect, useRef, useState } from 'react';

import { AGENT_FX_EVENT, findAnchorElement, type AgentFxDetail } from '../agent-ui/agentFx';
import './AgentFxLayer.css';

const GLOW_MS = 1600;
const CHIP_MS = 2200;
const NAV_MS = 450;

/**
 * Plays the agent-only effects (see agent-ui/agentFx.ts): a slide-in of the main
 * area when the agent switches tabs, a glow on the control it changed, and a small
 * "Assistant: …" chip. Renders only the chip; the rest is classes on existing nodes.
 */
export function AgentFxLayer() {
  const [chip, setChip] = useState<string | null>(null);
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFx = (event: Event) => {
      const detail = (event as CustomEvent<AgentFxDetail>).detail;
      if (!detail) return;

      setChip(detail.label);
      if (chipTimer.current) clearTimeout(chipTimer.current);
      chipTimer.current = setTimeout(() => setChip(null), CHIP_MS);

      if (detail.kind === 'navigate') {
        const main = document.querySelector<HTMLElement>('.app-main');
        if (main) {
          main.classList.remove('agent-fx-nav');
          // Re-trigger the animation on the next frame (after the new tab rendered).
          requestAnimationFrame(() => {
            main.classList.add('agent-fx-nav');
            setTimeout(() => main.classList.remove('agent-fx-nav'), NAV_MS);
          });
        }
        return;
      }

      // Wait a frame so a just-changed control (or a newly opened dialog) is in the DOM.
      requestAnimationFrame(() => {
        const el = findAnchorElement(detail.target);
        if (!el) return;
        el.classList.remove('agent-fx-glow');
        void el.offsetWidth; // restart the CSS animation
        el.classList.add('agent-fx-glow');
        setTimeout(() => el.classList.remove('agent-fx-glow'), GLOW_MS);
      });
    };
    window.addEventListener(AGENT_FX_EVENT, onFx);
    return () => {
      window.removeEventListener(AGENT_FX_EVENT, onFx);
      if (chipTimer.current) clearTimeout(chipTimer.current);
    };
  }, []);

  if (!chip) return null;
  return (
    <div className="agent-fx-chip" role="status" aria-live="polite">
      <i className="pi pi-sparkles" aria-hidden="true" />
      <span>{chip}</span>
    </div>
  );
}
