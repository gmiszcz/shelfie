import { useCallback, useEffect } from 'react';

import {
  type FinalMeta,
  type TranscriptLanguage,
  useVoiceInput,
} from '../chat/useVoiceInput';
import type { VoiceMachineConfig } from '../chat/voiceMachine';
import type { ChatScope } from '../types';
import './MicButton.css';

export interface MicButtonProps {
  /** Called with each finalized transcript. `autoSend` -> send immediately. */
  onFinal: (text: string, meta: FinalMeta) => void;
  /** Chat scope, forwarded to the hook for future per-scope UX. */
  scope?: ChatScope;
  /** Transcription language (controlled by the parent's PL/EN toggle). */
  language: TranscriptLanguage;
  /** Disable the control (e.g. while the assistant is streaming a reply). */
  disabled?: boolean;
  /** Override VAD/silence timings (tests). */
  config?: VoiceMachineConfig;
}

/**
 * Microphone button for the chat input.
 *
 * - Click starts recording; click again stops (manual stop drops the text into
 *   the input for review). `Ctrl+M` toggles start/stop while the app is focused.
 *   `Esc` cancels without sending.
 * - End-of-speech is detected by the hook's RMS VAD: when the user stops
 *   talking after a final transcript, recording stops and the message is sent
 *   automatically; a long initial silence stops without sending.
 * - The live input level animates a glow ring around the button via a CSS
 *   custom property (`--mic-level`), set from the hook's smoothed level; the
 *   ring respects `prefers-reduced-motion` (the hook stops the rAF loop, so the
 *   property simply holds steady). Recording state is shown in red, with the
 *   partial transcript surfaced live above the input.
 */
export function MicButton({
  onFinal,
  scope,
  language,
  disabled = false,
  config,
}: MicButtonProps) {
  const voice = useVoiceInput(onFinal, scope, config);
  const { status, partial, level, error } = voice.state;
  const recording = status === 'recording';
  const requesting = status === 'requesting';

  // Global shortcuts: Ctrl+M toggles, Esc cancels while recording. These are
  // window-level so they work even when the chat input is not focused (and,
  // per the spec, the parent opens the chat on Ctrl+M when it is closed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (!disabled) {
          voice.toggle(language);
        }
      } else if (e.key === 'Escape' && recording) {
        e.preventDefault();
        voice.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, language, recording, voice]);

  const onClick = useCallback(() => {
    if (disabled) {
      return;
    }
    voice.toggle(language);
  }, [disabled, language, voice]);

  const title = recording
    ? 'Stop recording (Ctrl+M · Esc to cancel)'
    : 'Start voice input (Ctrl+M)';

  // Clamp the level for the CSS ring; a little gain makes quiet speech visible.
  const ringLevel = Math.min(1, level * 6);

  return (
    <div className="mic-button-wrap">
      {recording && partial && (
        <div className="mic-partial" role="status" aria-live="polite">
          {partial}
        </div>
      )}
      <button
        type="button"
        className={`mic-button${recording ? ' recording' : ''}`}
        style={{ ['--mic-level' as string]: String(ringLevel) }}
        aria-label={recording ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={recording}
        title={title}
        disabled={disabled || requesting}
        onClick={onClick}
      >
        <span className="mic-ring" aria-hidden="true" />
        <i
          className={`pi ${requesting ? 'pi-spin pi-spinner' : 'pi-microphone'}`}
          aria-hidden="true"
        />
      </button>
      {error && (
        <span className="mic-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
