import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatScope } from '../types';
import {
  DEFAULT_CONFIG,
  type VoiceEffect,
  type VoiceInput,
  type VoiceMachineConfig,
  type VoiceMachineState,
  frameRms,
  initialVoiceMachineState,
  voiceMachineStep,
} from './voiceMachine';

export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  /** Live interim transcript, shown above the input while recording. */
  partial: string;
  /** Smoothed input level (0..1) driving the mic-button glow. */
  level: number;
  error: string | null;
}

export type TranscriptLanguage = 'pl-PL' | 'en-US';

/** Metadata handed to the caller with a finalized transcript. */
export interface FinalMeta {
  /** True when the VAD ended the utterance: ChatWidget should send immediately. */
  autoSend: boolean;
}

/** A float32 [-1, 1] buffer -> 16-bit little-endian PCM bytes. */
function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out.buffer;
}

/** Linear-resample a mono float buffer from srcRate to dstRate. */
function downsample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (dstRate >= srcRate) {
    return input;
  }
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    out[i] = input[Math.floor(i * ratio)];
  }
  return out;
}

const TARGET_RATE = 16_000;
const WS_PATH = '/api/transcribe/stream';
/** How often the silence timers are evaluated (ms). */
const TICK_INTERVAL_MS = 150;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${WS_PATH}`;
}

function statusFrom(phase: VoiceMachineState['phase']): VoiceStatus {
  return phase === 'recording' ? 'recording' : 'idle';
}

/**
 * Microphone voice input. Captures audio in the browser, downsamples it to
 * 16 kHz PCM and streams it to the backend `/api/transcribe/stream` WebSocket,
 * while a pure {@link voiceMachine} decides — from a local RMS VAD plus the
 * Transcribe final results — when to stop and whether to auto-send.
 *
 * The caller passes `onFinal(text, { autoSend })`: `autoSend` is true when the
 * VAD ended the utterance (ChatWidget sends immediately) and false on a manual
 * stop (the text is dropped into the input box for review). Esc cancels and
 * sends nothing. `start`/`stop`/`cancel`/`toggle` are the imperative controls;
 * Ctrl+M (while the app is focused) toggles recording.
 *
 * Teardown is centralized in {@link cleanup}: it disconnects the audio graph,
 * closes the AudioContext, stops every mic track (so the browser recording
 * indicator goes off) and closes the backend stream, so no Transcribe stream
 * is left dangling.
 */
export function useVoiceInput(
  onFinal: (text: string, meta: FinalMeta) => void,
  _scope?: ChatScope,
  config: VoiceMachineConfig = DEFAULT_CONFIG,
) {
  const [state, setState] = useState<VoiceState>({
    status: 'idle',
    partial: '',
    level: 0,
    error: null,
  });

  // The pure machine state lives in a ref (frames/ticks fire outside React).
  const machineRef = useRef<VoiceMachineState>(initialVoiceMachineState);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const configRef = useRef(config);
  configRef.current = config;

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const tickRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    procRef.current?.disconnect();
    sourceRef.current?.disconnect();
    procRef.current = null;
    sourceRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close();
    }
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'stop' }));
        }
        ws.close();
      } catch {
        // socket already closing
      }
    }
    wsRef.current = null;
  }, []);

  /** Apply one machine effect (teardown releases hardware; final notifies the caller). */
  const runEffects = useCallback(
    (effects: VoiceEffect[]) => {
      for (const effect of effects) {
        if (effect.type === 'teardown') {
          cleanup();
        } else if (effect.type === 'final') {
          onFinalRef.current(effect.text, { autoSend: effect.autoSend });
        }
      }
    },
    [cleanup],
  );

  /** Feed one input into the machine and mirror the result into React state. */
  const dispatch = useCallback(
    (input: VoiceInput) => {
      const { state: next, effects } = voiceMachineStep(machineRef.current, input, configRef.current);
      machineRef.current = next;
      runEffects(effects);
      setState((s) => {
        const status = s.status === 'error' || s.status === 'requesting' ? s.status : statusFrom(next.phase);
        // A teardown effect always returns to idle regardless of prior status.
        const settled = effects.some((e) => e.type === 'teardown') ? 'idle' : status;
        return { ...s, status: settled, partial: next.partial, level: next.level };
      });
    },
    [runEffects],
  );

  const stop = useCallback((at: number = performance.now()) => {
    dispatch({ kind: 'stop', at });
  }, [dispatch]);

  const cancel = useCallback((at: number = performance.now()) => {
    dispatch({ kind: 'cancel', at });
    setState({ status: 'idle', partial: '', level: 0, error: null });
  }, [dispatch]);

  const start = useCallback(
    async (language: TranscriptLanguage = 'pl-PL') => {
      if (machineRef.current.phase === 'recording') {
        return;
      }
      setState({ status: 'requesting', partial: '', level: 0, error: null });

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const denied = err instanceof DOMException && err.name === 'NotAllowedError';
        setState({
          status: 'error',
          partial: '',
          level: 0,
          error: denied
            ? 'Microphone permission denied. Allow access in your browser to use voice.'
            : 'Could not access the microphone.',
        });
        return;
      }
      streamRef.current = stream;

      const ws = new WebSocket(wsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        let msg: { type: string; text?: string; message?: string };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === 'partial') {
          dispatch({ kind: 'transcript', text: msg.text ?? '', isFinal: false });
        } else if (msg.type === 'final') {
          dispatch({ kind: 'transcript', text: msg.text ?? '', isFinal: true });
        } else if (msg.type === 'error') {
          setState({ status: 'error', partial: '', level: 0, error: msg.message ?? 'Transcription error.' });
          machineRef.current = initialVoiceMachineState;
          cleanup();
        }
      };

      ws.onerror = () => {
        setState((s) =>
          s.status === 'error'
            ? s
            : { status: 'error', partial: '', level: 0, error: 'Voice connection failed.' },
        );
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'start', language }));

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;
        // ScriptProcessor is deprecated but universally available and adequate
        // for a 16 kHz voice capture; an AudioWorklet could replace it later.
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        procRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const input = e.inputBuffer.getChannelData(0);
          // Feed the raw frame RMS to the VAD before any resampling.
          dispatch({ kind: 'frame', rms: frameRms(input), at: performance.now() });
          const pcm = floatTo16BitPcm(downsample(input, ctx.sampleRate, TARGET_RATE));
          ws.send(pcm);
        };
        source.connect(processor);
        processor.connect(ctx.destination);

        machineRef.current = voiceMachineStep(
          machineRef.current,
          { kind: 'start', at: performance.now() },
          configRef.current,
        ).state;

        // Evaluate the silence timers on a steady clock, independent of frames.
        tickRef.current = window.setInterval(() => {
          dispatch({ kind: 'tick', at: performance.now() });
        }, TICK_INTERVAL_MS);

        // Smooth the displayed glow level toward the machine level with rAF, so
        // it animates even between audio frames and honours reduced motion.
        const reduceMotion =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduceMotion) {
          const animate = () => {
            setState((s) =>
              s.status === 'recording' ? { ...s, level: machineRef.current.level } : s,
            );
            rafRef.current = requestAnimationFrame(animate);
          };
          rafRef.current = requestAnimationFrame(animate);
        }

        setState({ status: 'recording', partial: '', level: 0, error: null });
      };
    },
    [cleanup, dispatch],
  );

  /** Toggle recording: start if idle, otherwise a manual stop. */
  const toggle = useCallback(
    (language: TranscriptLanguage = 'pl-PL') => {
      if (machineRef.current.phase === 'recording') {
        stop();
      } else {
        void start(language);
      }
    },
    [start, stop],
  );

  useEffect(() => cleanup, [cleanup]);

  return { state, start, stop, cancel, toggle };
}
