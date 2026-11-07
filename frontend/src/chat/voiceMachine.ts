/**
 * Pure voice-input state machine with a local RMS voice-activity detector (VAD).
 *
 * This module holds NO browser APIs and NO React: it is a reducer over an
 * immutable {@link VoiceMachineState} driven by three kinds of input — audio
 * frames (RMS level + timestamp), Transcribe transcript events, and user
 * actions (start / stop / cancel) — plus a periodic `tick`. Every transition
 * returns the next state together with a list of {@link VoiceEffect}s the
 * impure hook must carry out (stop the stream, send the message, …).
 *
 * Keeping the end-of-speech decision here means it can be unit-tested by
 * feeding synthetic RMS frames and transcript events and asserting the
 * stop/send decisions, with no audio hardware or AWS.
 *
 * End-of-speech rules (all timings are configurable constants):
 *  - While recording, any frame whose RMS is above {@link VAD_RMS_THRESHOLD}
 *    counts as speech and refreshes the "last speech" timestamp.
 *  - Once at least one FINAL transcript has arrived, a gap of
 *    {@link SILENCE_AFTER_SPEECH_MS} with no speech stops recording AND sends
 *    the accumulated text automatically (auto-send).
 *  - If NOTHING was ever said (no final transcript and never any speech above
 *    threshold), a longer gap of {@link SILENCE_NO_SPEECH_MS} stops recording
 *    WITHOUT sending.
 *  - A manual stop stops recording and, if there is final text, hands it over
 *    with `autoSend: false` (the user reviews before sending).
 *  - Cancel (Esc) stops recording and discards everything.
 */

/** RMS level (0..1) above which a frame is treated as speech, not silence. */
export const VAD_RMS_THRESHOLD = 0.015;

/** Silence after a final transcript that ends the utterance and auto-sends. */
export const SILENCE_AFTER_SPEECH_MS = 1_500;

/** Silence with nothing said at all that stops recording without sending. */
export const SILENCE_NO_SPEECH_MS = 8_000;

/** Hard safety cap on a single utterance: never record longer than this. */
export const MAX_RECORDING_MS = 60_000;

export interface VoiceMachineConfig {
  /** RMS threshold for the speech/silence decision. */
  rmsThreshold: number;
  /** Trailing silence (ms) after speech that triggers auto-send. */
  silenceAfterSpeechMs: number;
  /** Trailing silence (ms) with nothing said that stops without sending. */
  silenceNoSpeechMs: number;
  /** Hard cap (ms): recording always stops once this elapses. */
  maxDurationMs: number;
}

export const DEFAULT_CONFIG: VoiceMachineConfig = {
  rmsThreshold: VAD_RMS_THRESHOLD,
  silenceAfterSpeechMs: SILENCE_AFTER_SPEECH_MS,
  silenceNoSpeechMs: SILENCE_NO_SPEECH_MS,
  maxDurationMs: MAX_RECORDING_MS,
};

export type VoicePhase = 'idle' | 'recording';

export interface VoiceMachineState {
  phase: VoicePhase;
  /** Latest interim (partial) transcript, shown live above the input. */
  partial: string;
  /** Concatenated finalized transcript segments for this utterance. */
  finalText: string;
  /** Whether at least one final transcript has arrived this utterance. */
  hasFinal: boolean;
  /** Whether any frame above threshold has been observed this utterance. */
  heardSpeech: boolean;
  /** Smoothed RMS level (0..1) for the visual glow. */
  level: number;
  /** Timestamp (ms) of the last speech frame, or recording start. */
  lastSpeechAt: number;
  /** Timestamp (ms) when recording started, for the hard duration cap. */
  startedAt: number;
}

export const initialVoiceMachineState: VoiceMachineState = {
  phase: 'idle',
  partial: '',
  finalText: '',
  hasFinal: false,
  heardSpeech: false,
  level: 0,
  lastSpeechAt: 0,
  startedAt: 0,
};

export type VoiceInput =
  | { kind: 'start'; at: number }
  /** A manual stop (second mic click / Ctrl+M while recording). */
  | { kind: 'stop'; at: number }
  /** Esc: abandon recording, send nothing. */
  | { kind: 'cancel'; at: number }
  /** One audio frame: its RMS level and capture time. */
  | { kind: 'frame'; rms: number; at: number }
  /** A transcript event from the backend WebSocket. */
  | { kind: 'transcript'; text: string; isFinal: boolean }
  /** A periodic clock tick used only to evaluate the silence timers. */
  | { kind: 'tick'; at: number };

export type VoiceEffect =
  /** Tear down the audio graph, mic tracks and backend stream. */
  | { type: 'teardown' }
  /** Hand the finalized text to the caller. `autoSend` drives ChatWidget. */
  | { type: 'final'; text: string; autoSend: boolean };

export interface VoiceStep {
  state: VoiceMachineState;
  effects: VoiceEffect[];
}

/** Exponential smoothing factor for the displayed level (0..1, higher = snappier). */
const LEVEL_SMOOTHING = 0.3;

function startedState(at: number): VoiceMachineState {
  return {
    phase: 'recording',
    partial: '',
    finalText: '',
    hasFinal: false,
    heardSpeech: false,
    level: 0,
    lastSpeechAt: at,
    startedAt: at,
  };
}

/** Collapse runs of whitespace and trim — used when joining transcript segments. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Advance the machine by one input, returning the next state and any effects.
 * Pure: it reads only `state`, `input` and `config` and allocates a new state.
 */
export function voiceMachineStep(
  state: VoiceMachineState,
  input: VoiceInput,
  config: VoiceMachineConfig = DEFAULT_CONFIG,
): VoiceStep {
  switch (input.kind) {
    case 'start': {
      if (state.phase === 'recording') {
        return { state, effects: [] };
      }
      return { state: startedState(input.at), effects: [] };
    }

    case 'cancel': {
      if (state.phase === 'idle') {
        return { state, effects: [] };
      }
      return { state: { ...initialVoiceMachineState }, effects: [{ type: 'teardown' }] };
    }

    case 'stop': {
      if (state.phase === 'idle') {
        return { state, effects: [] };
      }
      const text = normalizeText(state.finalText || state.partial);
      const effects: VoiceEffect[] = [{ type: 'teardown' }];
      if (text) {
        effects.push({ type: 'final', text, autoSend: false });
      }
      return { state: { ...initialVoiceMachineState }, effects };
    }

    case 'frame': {
      if (state.phase !== 'recording') {
        return { state, effects: [] };
      }
      const speaking = input.rms >= config.rmsThreshold;
      const level = state.level + (input.rms - state.level) * LEVEL_SMOOTHING;
      return {
        state: {
          ...state,
          level,
          heardSpeech: state.heardSpeech || speaking,
          lastSpeechAt: speaking ? input.at : state.lastSpeechAt,
        },
        effects: [],
      };
    }

    case 'transcript': {
      if (state.phase !== 'recording') {
        return { state, effects: [] };
      }
      if (input.isFinal) {
        const finalText = normalizeText(`${state.finalText} ${input.text}`);
        return {
          state: { ...state, partial: '', finalText, hasFinal: true },
          effects: [],
        };
      }
      return { state: { ...state, partial: input.text }, effects: [] };
    }

    case 'tick': {
      if (state.phase !== 'recording') {
        return { state, effects: [] };
      }
      const silenceMs = input.at - state.lastSpeechAt;
      // Hard safety cap: never record past maxDurationMs. Send whatever text we
      // have (auto-send) so a long utterance is not silently discarded.
      if (input.at - state.startedAt >= config.maxDurationMs) {
        const text = normalizeText(state.finalText || state.partial);
        const effects: VoiceEffect[] = [{ type: 'teardown' }];
        if (text) {
          effects.push({ type: 'final', text, autoSend: true });
        }
        return { state: { ...initialVoiceMachineState }, effects };
      }
      // End-of-speech: a final transcript exists and the user has gone quiet.
      if (state.hasFinal && silenceMs >= config.silenceAfterSpeechMs) {
        const text = normalizeText(state.finalText || state.partial);
        const effects: VoiceEffect[] = [{ type: 'teardown' }];
        if (text) {
          effects.push({ type: 'final', text, autoSend: true });
        }
        return { state: { ...initialVoiceMachineState }, effects };
      }
      // Nothing said for a long time: stop quietly, send nothing.
      if (!state.hasFinal && !state.heardSpeech && silenceMs >= config.silenceNoSpeechMs) {
        return { state: { ...initialVoiceMachineState }, effects: [{ type: 'teardown' }] };
      }
      return { state, effects: [] };
    }

    default: {
      input satisfies never;
      return { state, effects: [] };
    }
  }
}

/** RMS (0..1) of a float32 PCM frame — the VAD input the hook computes per frame. */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}
