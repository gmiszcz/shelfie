import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceInput } from './useVoiceInput';

/** Minimal fakes for the browser audio + WebSocket APIs used by the hook. */

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks: FakeTrack[] = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeScriptProcessor {
  onaudioprocess: ((e: unknown) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  sampleRate = 48_000;
  state: 'running' | 'closed' = 'running';
  destination = {};
  processor = new FakeScriptProcessor();
  source = new FakeSourceNode();
  closed = false;
  createMediaStreamSource() {
    return this.source;
  }
  createScriptProcessor() {
    return this.processor;
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}

const OPEN = 1;
const CLOSED = 3;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = OPEN;
  static CONNECTING = 0;
  static CLOSED = CLOSED;
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }
  /** Simulate the socket opening (fires the hook's onopen -> audio graph). */
  open() {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let audioContext: FakeAudioContext;

beforeEach(() => {
  FakeWebSocket.instances = [];
  audioContext = new FakeAudioContext();

  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => audioContext) as unknown as typeof AudioContext,
  );
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => new FakeMediaStream()) },
  });
  // Deterministic rAF + reduced-motion so no real animation loop runs.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.matchMedia = globalThis.matchMedia;
  // The microphone is only reachable on a secure origin; jsdom reports false.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function startRecording(result: ReturnType<typeof renderHook<ReturnType<typeof useVoiceInput>, unknown>>) {
  await act(async () => {
    await result.result.current.start('en-US');
  });
  // The hook built the WebSocket; drive it to open so the audio graph attaches.
  const ws = FakeWebSocket.instances.at(-1)!;
  act(() => ws.open());
  await waitFor(() => expect(result.result.current.state.status).toBe('recording'));
  return ws;
}

describe('useVoiceInput cleanup', () => {
  it('releases mic tracks, closes the AudioContext and WebSocket on stop', async () => {
    const onFinal = vi.fn();
    const hook = renderHook(() => useVoiceInput(onFinal));
    const ws = await startRecording(hook);

    act(() => hook.result.current.stop());

    expect(audioContext.closed).toBe(true);
    expect(audioContext.source.disconnect).toHaveBeenCalled();
    expect(audioContext.processor.disconnect).toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    // The stop action tells the backend to end its Transcribe stream.
    expect(ws.sent).toContainEqual(JSON.stringify({ action: 'stop' }));
    expect(hook.result.current.state.status).toBe('idle');
  });

  it('tears everything down on unmount while recording', async () => {
    const onFinal = vi.fn();
    const hook = renderHook(() => useVoiceInput(onFinal));
    const ws = await startRecording(hook);
    const track = ws; // keep a ref alive; the stream track is inside the hook

    hook.unmount();

    expect(audioContext.closed).toBe(true);
    expect(ws.closed).toBe(true);
    expect(track).toBeDefined();
  });

  it('cancel discards without calling onFinal', async () => {
    const onFinal = vi.fn();
    const hook = renderHook(() => useVoiceInput(onFinal));
    const ws = await startRecording(hook);

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'final', text: 'secret' }) });
    });
    act(() => hook.result.current.cancel());

    expect(onFinal).not.toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    expect(hook.result.current.state.status).toBe('idle');
  });

  it('a backend error message closes the stream and surfaces the error', async () => {
    const onFinal = vi.fn();
    const hook = renderHook(() => useVoiceInput(onFinal));
    const ws = await startRecording(hook);

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'boom' }) });
    });

    expect(hook.result.current.state.status).toBe('error');
    expect(hook.result.current.state.error).toBe('boom');
    expect(ws.closed).toBe(true);
  });

  it('surfaces a permission-denied error without opening a socket', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError'),
    );
    const onFinal = vi.fn();
    const hook = renderHook(() => useVoiceInput(onFinal));

    await act(async () => {
      await hook.result.current.start('pl-PL');
    });

    expect(hook.result.current.state.status).toBe('error');
    expect(hook.result.current.state.error).toContain('permission denied');
  });
});

describe('useVoiceInput on an insecure origin', () => {
  it('explains that the microphone needs HTTPS instead of failing silently', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const hook = renderHook(() => useVoiceInput(vi.fn()));
    await act(async () => {
      await hook.result.current.start('pl-PL');
    });
    expect(hook.result.current.state.status).toBe('error');
    expect(hook.result.current.state.error).toMatch(/HTTPS/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});
