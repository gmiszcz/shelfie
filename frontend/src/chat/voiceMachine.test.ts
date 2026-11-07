import { describe, expect, it } from 'vitest';

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

const CONFIG: VoiceMachineConfig = {
  rmsThreshold: 0.02,
  silenceAfterSpeechMs: 1_500,
  silenceNoSpeechMs: 8_000,
  maxDurationMs: 60_000,
};

/** Fold a list of inputs through the machine, collecting every emitted effect. */
function run(
  inputs: VoiceInput[],
  config: VoiceMachineConfig = CONFIG,
  from: VoiceMachineState = initialVoiceMachineState,
): { state: VoiceMachineState; effects: VoiceEffect[] } {
  let state = from;
  const effects: VoiceEffect[] = [];
  for (const input of inputs) {
    const step = voiceMachineStep(state, input, config);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const LOUD = CONFIG.rmsThreshold * 2;
const QUIET = CONFIG.rmsThreshold / 4;

describe('voiceMachineStep', () => {
  it('start enters the recording phase and emits no effect', () => {
    const { state, effects } = run([{ kind: 'start', at: 0 }]);
    expect(state.phase).toBe('recording');
    expect(effects).toEqual([]);
  });

  it('ignores a second start while already recording', () => {
    const { state } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 100 },
      { kind: 'start', at: 200 },
    ]);
    // The second start must not reset heardSpeech/lastSpeechAt.
    expect(state.heardSpeech).toBe(true);
    expect(state.lastSpeechAt).toBe(100);
  });

  it('a loud frame marks speech and refreshes lastSpeechAt', () => {
    const { state } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 300 },
    ]);
    expect(state.heardSpeech).toBe(true);
    expect(state.lastSpeechAt).toBe(300);
  });

  it('a quiet frame does not count as speech', () => {
    const { state } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: QUIET, at: 300 },
    ]);
    expect(state.heardSpeech).toBe(false);
    expect(state.lastSpeechAt).toBe(0);
  });

  it('auto-sends after a final transcript + trailing silence', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 100 },
      { kind: 'transcript', text: 'ile mam książek', isFinal: true },
      { kind: 'frame', rms: QUIET, at: 1_600 },
      // 100 (last speech) + 1500 silence reached at 1600.
      { kind: 'tick', at: 1_600 },
    ]);
    expect(effects).toEqual([
      { type: 'teardown' },
      { type: 'final', text: 'ile mam książek', autoSend: true },
    ]);
    expect(state.phase).toBe('idle');
  });

  it('does not auto-send before the silence window elapses', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 100 },
      { kind: 'transcript', text: 'hello', isFinal: true },
      { kind: 'tick', at: 1_000 }, // only 900ms of silence
    ]);
    expect(effects).toEqual([]);
    expect(state.phase).toBe('recording');
  });

  it('does not auto-send while there is no final transcript yet', () => {
    const { effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 100 },
      { kind: 'transcript', text: 'partial words', isFinal: false },
      { kind: 'tick', at: 2_000 }, // long silence, but no final
    ]);
    expect(effects).toEqual([]);
  });

  it('new speech after a final resets the silence timer (no premature send)', () => {
    const { effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'first', isFinal: true },
      { kind: 'frame', rms: QUIET, at: 1_000 },
      { kind: 'frame', rms: LOUD, at: 1_400 }, // speaking again
      { kind: 'tick', at: 1_600 }, // only 200ms since last speech
    ]);
    expect(effects).toEqual([]);
  });

  it('stops without sending after a long initial silence with nothing said', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: QUIET, at: 4_000 },
      { kind: 'tick', at: 8_000 },
    ]);
    expect(effects).toEqual([{ type: 'teardown' }]);
    expect(state.phase).toBe('idle');
  });

  it('does not treat a short silence as the no-speech timeout', () => {
    const { effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'tick', at: 5_000 },
    ]);
    expect(effects).toEqual([]);
  });

  it('hard cap stops and auto-sends after maxDurationMs even while still speaking', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'a very long dictation', isFinal: true },
      // Still speaking right up to the cap (silence timer would never fire).
      { kind: 'frame', rms: LOUD, at: 59_900 },
      { kind: 'tick', at: 60_000 },
    ]);
    expect(effects).toEqual([
      { type: 'teardown' },
      { type: 'final', text: 'a very long dictation', autoSend: true },
    ]);
    expect(state.phase).toBe('idle');
  });

  it('hard cap stops even with no transcript and sends nothing', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 59_000 }, // heard speech, but no final text
      { kind: 'tick', at: 60_000 },
    ]);
    expect(effects).toEqual([{ type: 'teardown' }]);
    expect(state.phase).toBe('idle');
  });

  it('does not hit the hard cap before maxDurationMs elapses', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: LOUD, at: 59_000 },
      { kind: 'tick', at: 59_500 }, // under 60s, speech still recent
    ]);
    expect(effects).toEqual([]);
    expect(state.phase).toBe('recording');
  });

  it('manual stop tears down and hands over the text with autoSend=false', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'draft message', isFinal: true },
      { kind: 'stop', at: 500 },
    ]);
    expect(effects).toEqual([
      { type: 'teardown' },
      { type: 'final', text: 'draft message', autoSend: false },
    ]);
    expect(state.phase).toBe('idle');
  });

  it('manual stop with no text only tears down', () => {
    const { effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'stop', at: 500 },
    ]);
    expect(effects).toEqual([{ type: 'teardown' }]);
  });

  it('manual stop falls back to the partial transcript when there is no final', () => {
    const { effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'live words', isFinal: false },
      { kind: 'stop', at: 500 },
    ]);
    expect(effects).toEqual([
      { type: 'teardown' },
      { type: 'final', text: 'live words', autoSend: false },
    ]);
  });

  it('cancel tears down and discards everything (no final effect)', () => {
    const { state, effects } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'secret', isFinal: true },
      { kind: 'cancel', at: 500 },
    ]);
    expect(effects).toEqual([{ type: 'teardown' }]);
    expect(state).toEqual(initialVoiceMachineState);
  });

  it('joins multiple final segments with single spaces', () => {
    const { state } = run([
      { kind: 'start', at: 0 },
      { kind: 'transcript', text: 'ile mam', isFinal: true },
      { kind: 'transcript', text: 'książek w sumie', isFinal: true },
    ]);
    expect(state.finalText).toBe('ile mam książek w sumie');
  });

  it('a partial transcript is exposed live and cleared by the next final', () => {
    let step = voiceMachineStep(initialVoiceMachineState, { kind: 'start', at: 0 }, CONFIG);
    step = voiceMachineStep(step.state, { kind: 'transcript', text: 'ile', isFinal: false }, CONFIG);
    expect(step.state.partial).toBe('ile');
    step = voiceMachineStep(
      step.state,
      { kind: 'transcript', text: 'ile mam', isFinal: true },
      CONFIG,
    );
    expect(step.state.partial).toBe('');
    expect(step.state.finalText).toBe('ile mam');
  });

  it('frames and transcripts while idle are ignored', () => {
    const { state, effects } = run([
      { kind: 'frame', rms: LOUD, at: 10 },
      { kind: 'transcript', text: 'noise', isFinal: true },
      { kind: 'tick', at: 9_999 },
    ]);
    expect(state).toEqual(initialVoiceMachineState);
    expect(effects).toEqual([]);
  });

  it('smooths the displayed level toward the frame RMS', () => {
    const { state } = run([
      { kind: 'start', at: 0 },
      { kind: 'frame', rms: 0.5, at: 100 },
    ]);
    // One step of exponential smoothing from 0 toward 0.5 (<0.5, >0).
    expect(state.level).toBeGreaterThan(0);
    expect(state.level).toBeLessThan(0.5);
  });

  it('exposes usable defaults', () => {
    expect(DEFAULT_CONFIG.silenceAfterSpeechMs).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.silenceNoSpeechMs).toBeGreaterThan(DEFAULT_CONFIG.silenceAfterSpeechMs);
    expect(DEFAULT_CONFIG.maxDurationMs).toBeGreaterThan(DEFAULT_CONFIG.silenceNoSpeechMs);
  });
});

describe('frameRms', () => {
  it('is 0 for an empty frame', () => {
    expect(frameRms(new Float32Array(0))).toBe(0);
  });

  it('is 0 for silence', () => {
    expect(frameRms(new Float32Array(16))).toBe(0);
  });

  it('computes the root-mean-square of a constant-amplitude frame', () => {
    const f = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(frameRms(f)).toBeCloseTo(0.5, 6);
  });

  it('grows with amplitude', () => {
    const quiet = frameRms(new Float32Array([0.01, -0.01]));
    const loud = frameRms(new Float32Array([0.9, -0.9]));
    expect(loud).toBeGreaterThan(quiet);
  });
});
