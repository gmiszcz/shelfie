import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatScope } from '../types';

export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  partial: string;
  error: string | null;
}

export type TranscriptLanguage = 'pl-PL' | 'en-US';

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

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${WS_PATH}`;
}

/**
 * Microphone voice input: records audio in the browser, downsamples to 16 kHz
 * PCM and streams it to the backend `/api/transcribe/stream` WebSocket, which
 * returns partial + final transcripts. Finals are appended via `onFinal`
 * (the ChatWidget drops them into the input box); partials drive the live
 * recording indicator. The caller may pass `scope` for future per-scope UX.
 */
export function useVoiceInput(onFinal: (text: string) => void, _scope?: ChatScope) {
  const [state, setState] = useState<VoiceState>({ status: 'idle', partial: '', error: null });

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const cleanup = useCallback(() => {
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: 'stop' }));
      } catch {
        // socket already closing
      }
    }
    wsRef.current = null;
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState((s) => ({ ...s, status: 'idle', partial: '' }));
  }, [cleanup]);

  const start = useCallback(
    async (language: TranscriptLanguage = 'pl-PL') => {
      setState({ status: 'requesting', partial: '', error: null });

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const denied = err instanceof DOMException && err.name === 'NotAllowedError';
        setState({
          status: 'error',
          partial: '',
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
          setState((s) => ({ ...s, partial: msg.text ?? '' }));
        } else if (msg.type === 'final') {
          if (msg.text) {
            onFinal(msg.text);
          }
          setState((s) => ({ ...s, partial: '' }));
        } else if (msg.type === 'error') {
          setState({ status: 'error', partial: '', error: msg.message ?? 'Transcription error.' });
          cleanup();
        }
      };

      ws.onerror = () => {
        setState((s) =>
          s.status === 'error'
            ? s
            : { status: 'error', partial: '', error: 'Voice connection failed.' },
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
          const pcm = floatTo16BitPcm(downsample(input, ctx.sampleRate, TARGET_RATE));
          ws.send(pcm);
        };
        source.connect(processor);
        processor.connect(ctx.destination);
        setState({ status: 'recording', partial: '', error: null });
      };
    },
    [cleanup, onFinal],
  );

  useEffect(() => cleanup, [cleanup]);

  return { state, start, stop };
}
