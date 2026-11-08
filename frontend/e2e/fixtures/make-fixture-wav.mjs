// Regenerate the fake-audio fixture `speech.wav` used by the global-mic
// Playwright check (voice-global-mic.mjs), WITHOUT any AWS / Polly call.
//
// The committed fixture was first cut from an Amazon Polly utterance, but the
// e2e stubs transcription (see voice-global-mic.mjs), so the WAV only has to be
// a VALID 16 kHz / mono / 16-bit-PCM file that carries real audio ENERGY
// followed by silence — enough for the browser's fake-audio capture to feed
// `getUserMedia`, drive the hook's RMS VAD past the speech threshold, and then
// trigger the silence auto-stop. This generator synthesizes exactly that, so
// the fixture is fully reproducible on any machine with Node and no cloud.
//
// Usage:  node frontend/e2e/fixtures/make-fixture-wav.mjs [out.wav]
// Default output: this directory's speech.wav

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const SAMPLE_RATE = 16_000; // the capture pipeline downsamples to 16 kHz
const SPEECH_SECONDS = 2.0; // "utterance" long enough to produce a final transcript
const SILENCE_SECONDS = 3.0; // trailing silence so the VAD auto-stops (>1.5 s)
// Well above the hook's VAD_RMS_THRESHOLD (0.015) so frames read as speech.
const AMPLITUDE = 0.35;

function synthSpeechLike(samples) {
  // A couple of formant-ish tones, amplitude-modulated like syllables, plus a
  // little noise — not intelligible, but spectrally and energetically "voice".
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); // ~4 Hz envelope
    const f1 = Math.sin(2 * Math.PI * 180 * t);
    const f2 = 0.6 * Math.sin(2 * Math.PI * 440 * t);
    const noise = 0.15 * (Math.random() * 2 - 1);
    out[i] = AMPLITUDE * syllable * (f1 + f2 + noise);
  }
  return out;
}

function floatToPcm16(float32) {
  const buf = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
  }
  return buf;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // channels = 1 (mono)
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : resolve(here, 'speech.wav');

const speech = synthSpeechLike(Math.round(SPEECH_SECONDS * SAMPLE_RATE));
const silence = new Float32Array(Math.round(SILENCE_SECONDS * SAMPLE_RATE)); // zeros
const pcm = Buffer.concat([floatToPcm16(speech), floatToPcm16(silence)]);
writeFileSync(out, wav(pcm));

const totalSec = (pcm.length / (SAMPLE_RATE * 2)).toFixed(1);
console.log(`wrote ${out}: ${44 + pcm.length} bytes (${totalSec}s, ${SAMPLE_RATE} Hz mono 16-bit)`);
