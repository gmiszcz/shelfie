import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './services/api';
import { resetWarmUpForTests, warmUpOnce } from './warmup';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('warmUpOnce', () => {
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetWarmUpForTests();
    call = vi.spyOn(api, 'warmup').mockResolvedValue({ timings_ms: {} });
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls the server once per app open, however often it is asked', async () => {
    warmUpOnce();
    warmUpOnce();
    await vi.runAllTimersAsync();
    warmUpOnce();
    await vi.runAllTimersAsync();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('waits for the tab to be visible', async () => {
    setVisibility('hidden');
    warmUpOnce();
    await vi.runAllTimersAsync();
    expect(call).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed warm-up', async () => {
    call.mockRejectedValue(new Error('offline'));
    warmUpOnce();
    await vi.runAllTimersAsync();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
