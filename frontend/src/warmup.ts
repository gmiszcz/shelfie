import { api } from './services/api';

let started = false;

/**
 * Ask the server once per app open to warm up the mic (Transcribe) and the agent.
 *
 * Free and quiet: no microphone, no audio, no timers. It runs when the browser is
 * idle and the tab is visible; a hidden tab waits for the first time it is shown.
 * Only the logged-in app calls it (it sits inside AuthGate), and the server also
 * requires a login. Errors are ignored: a failed warm-up only means a slower first use.
 */
export function warmUpOnce(): void {
  if (started) return;
  const run = () => {
    if (started) return;
    started = true;
    try {
      void api.warmup().catch(() => undefined);
    } catch {
      // never let a warm-up break the app (e.g. a partial api mock in a test)
    }
  };
  const whenIdle = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 0);
  };
  if (document.visibilityState === 'visible') {
    whenIdle();
    return;
  }
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    whenIdle();
  };
  document.addEventListener('visibilitychange', onVisible);
}

/** Test seam: forget that the warm-up already ran. */
export function resetWarmUpForTests(): void {
  started = false;
}
