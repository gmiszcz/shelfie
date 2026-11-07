import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';

import {
  type FinalMeta,
  type TranscriptLanguage,
  useVoiceInput,
} from '../chat/useVoiceInput';
import type { VoiceMachineConfig } from '../chat/voiceMachine';
import type { ChatScope } from '../types';
import './MicButton.css';

/** Where the mic lives, which changes only its size/shell styling. */
export type MicVariant = 'chat' | 'global';

/** Imperative controls the parent can drive (e.g. central Ctrl+M routing). */
export interface MicHandle {
  toggle: (language?: TranscriptLanguage) => void;
  start: (language?: TranscriptLanguage) => void;
  stop: () => void;
  cancel: () => void;
  isRecording: () => boolean;
}

export interface MicButtonProps {
  /** Called with each finalized transcript. `autoSend` -> send immediately. */
  onFinal: (text: string, meta: FinalMeta) => void;
  /** Chat scope, forwarded to the hook for future per-scope UX. */
  scope?: ChatScope;
  /** Transcription language (controlled by the parent's PL/EN toggle). */
  language: TranscriptLanguage;
  /** Disable the control (e.g. while the assistant is streaming a reply). */
  disabled?: boolean;
  /** A chat request is in flight: show a circular loading ring around the mic. */
  busy?: boolean;
  /** Override VAD/silence timings (tests). */
  config?: VoiceMachineConfig;
  /**
   * Visual variant. `chat` (default) is the small inline input-row button;
   * `global` is the larger floating button that sits next to the chat bubble on
   * the main view. The behaviour (record / VAD / glow / errors) is identical.
   */
  variant?: MicVariant;
  /**
   * Own the window-level `Ctrl+M` (toggle) and `Esc` (cancel) shortcuts. Default
   * true (the standalone behaviour). The app routes Ctrl+M centrally — global
   * mic when the chat is closed, chat mic when open — so both mics pass
   * `captureShortcuts={false}` and the shell drives them through the ref.
   */
  captureShortcuts?: boolean;
  /** Called whenever the recording state flips, so the parent can show status. */
  onRecordingChange?: (recording: boolean) => void;
  /** Called with the hook's error text (e.g. the insecure-origin HTTPS message). */
  onError?: (error: string | null) => void;
  /** Hide the inline error element (the parent renders it, e.g. in a toast). */
  hideInlineError?: boolean;
  /** Accessible label override (defaults describe start/stop voice input). */
  label?: string;
}

/**
 * Microphone button, reused by the chat input (`variant="chat"`) and the main
 * view's floating global mic (`variant="global"`).
 *
 * - Click starts recording; click again stops (manual stop drops the text into
 *   the input for review via `onFinal`). `Esc` cancels without sending.
 * - End-of-speech is detected by the hook's RMS VAD: when the user stops
 *   talking after a final transcript, recording stops and the message is sent
 *   automatically; a long initial silence stops without sending.
 * - The live input level animates a glow ring via a CSS custom property
 *   (`--mic-level`), set from the hook's smoothed level; it respects
 *   `prefers-reduced-motion`. Recording state is shown in red.
 * - `Ctrl+M` is routed by the app shell (see ChatProvider / AppShell), not here,
 *   unless `captureShortcuts` is left on for standalone use.
 */
export const MicButton = forwardRef<MicHandle, MicButtonProps>(function MicButton(
  {
    onFinal,
    scope,
    language,
    disabled = false,
    busy = false,
    config,
    variant = 'chat',
    captureShortcuts = true,
    onRecordingChange,
    onError,
    hideInlineError = false,
    label,
  },
  ref,
) {
  const voice = useVoiceInput(onFinal, scope, config);
  const { status, partial, level, error } = voice.state;
  const recording = status === 'recording';
  const requesting = status === 'requesting';

  // Expose imperative controls so the shell can route Ctrl+M to the right mic.
  useImperativeHandle(
    ref,
    () => ({
      toggle: (lang: TranscriptLanguage = language) => {
        if (!disabled) {
          voice.toggle(lang);
        }
      },
      start: (lang: TranscriptLanguage = language) => {
        if (!disabled) {
          void voice.start(lang);
        }
      },
      stop: () => voice.stop(),
      cancel: () => voice.cancel(),
      isRecording: () => recording,
    }),
    [disabled, language, recording, voice],
  );

  // Notify the parent of recording/error changes (toast, status ring, etc.).
  const prevRecording = useRef(recording);
  useEffect(() => {
    if (prevRecording.current !== recording) {
      prevRecording.current = recording;
      onRecordingChange?.(recording);
    }
  }, [recording, onRecordingChange]);
  useEffect(() => {
    onError?.(error);
  }, [error, onError]);

  // Standalone shortcuts (only when the shell does not route them centrally).
  useEffect(() => {
    if (!captureShortcuts) {
      return;
    }
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
  }, [captureShortcuts, disabled, language, recording, voice]);

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

  const defaultLabel = recording ? 'Stop voice input' : label ?? 'Start voice input';

  return (
    <div className={`mic-button-wrap mic-${variant}${busy ? ' busy' : ''}`}>
      {recording && partial && (
        <div className="mic-partial" role="status" aria-live="polite">
          {partial}
        </div>
      )}
      <button
        type="button"
        className={`mic-button mic-button-${variant}${recording ? ' recording' : ''}${
          busy ? ' busy' : ''
        }`}
        style={{ ['--mic-level' as string]: String(ringLevel) }}
        aria-label={defaultLabel}
        aria-pressed={recording}
        aria-busy={busy}
        title={title}
        disabled={disabled || requesting}
        onClick={onClick}
      >
        <span className="mic-ring" aria-hidden="true" />
        {busy && <span className="mic-progress" aria-hidden="true" />}
        <i
          className={`pi ${requesting ? 'pi-spin pi-spinner' : 'pi-microphone'}`}
          aria-hidden="true"
        />
      </button>
      {error && !hideInlineError && (
        <span className="mic-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
});
