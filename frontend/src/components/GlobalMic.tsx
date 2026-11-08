import { useCallback, useEffect, useRef, useState } from 'react';

import { useChat } from '../chat/ChatProvider';
import type { FinalMeta } from '../chat/useVoiceInput';
import { useSettings } from '../settings/SettingsContext';
import { MicButton, type MicHandle } from './MicButton';
import './GlobalMic.css';

/**
 * A module-level handle to the global mic, so the shell's single Ctrl+M listener
 * can toggle it when the chat panel is closed (and the chat mic when it is open),
 * without either mic owning the shortcut and double-firing. Null while the button
 * is hidden by the "Show voice button" setting.
 */
export const globalMicRegistry: { current: MicHandle | null } = { current: null };

/** How long the result toast stays before auto-hiding (ms). */
const TOAST_HIDE_MS = 6000;
/** Horizontal swipe distance that dismisses the toast (px). */
const SWIPE_DISMISS_PX = 60;

/** One toast payload: either a finished exchange, or a mic error (e.g. HTTPS). */
interface ToastContent {
  id: string;
  transcript: string;
  reply: string;
  ok: boolean;
  /** True for a mic/transport error (shown in the error style, not tappable to chat). */
  isError: boolean;
}

/**
 * The floating global microphone on the main view.
 *
 * It sits next to the chat bubble (bottom-right; lifted above the phone tab bar
 * and the home-indicator safe area) so the user can talk to the UNIVERSAL UI
 * agent without opening the chat panel — which, on a phone, covers the whole
 * screen. It reuses {@link MicButton} (`variant="global"`) and the shared
 * {@link useChat} state, so there is ONE UI-agent thread and client: a transcript
 * spoken here lands in the same conversation the panel shows.
 *
 * Flow:
 *   1. Tap the mic → record (red, RMS glow, VAD auto-stop on ~1.5 s silence; tap
 *      again stops; Esc cancels — routed centrally by the shell).
 *   2. The final transcript is sent to the UI agent WITHOUT opening the chat, so
 *      it can navigate, filter, search and open dialogs.
 *   3. While the agent works, the mic shows its in-flight ring.
 *   4. A small non-blocking toast appears near the mic with the transcript and
 *      the agent's short reply (auto-hides ~6 s; swipe or tap X to close).
 *      Tapping the toast opens the chat with that exchange appended to the thread.
 *   5. On an insecure origin (plain http), the hook's HTTPS error is shown in the
 *      toast instead of a transcript.
 *
 * Hidden when the "Show voice button" setting is off.
 */
export function GlobalMic() {
  const { settings } = useSettings();
  const { voiceLang, streaming, sendUiAgent, revealUiChat, lastUiExchange } = useChat();

  const micRef = useRef<MicHandle | null>(null);
  const [toast, setToast] = useState<ToastContent | null>(null);
  const hideTimer = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const [swipeDx, setSwipeDx] = useState(0);
  // Track that WE started an agent run from the mic, so we only show the toast
  // for exchanges the global mic produced (not panel-driven turns).
  const awaitingExchange = useRef(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showToast = useCallback(
    (content: ToastContent) => {
      clearHideTimer();
      setSwipeDx(0);
      setToast(content);
      hideTimer.current = window.setTimeout(() => {
        setToast(null);
        hideTimer.current = null;
      }, TOAST_HIDE_MS);
    },
    [clearHideTimer],
  );

  const dismissToast = useCallback(() => {
    clearHideTimer();
    setToast(null);
    setSwipeDx(0);
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  // Publish this mic's handle for the shell's central Ctrl+M routing.
  useEffect(() => {
    globalMicRegistry.current = micRef.current;
    return () => {
      if (globalMicRegistry.current === micRef.current) {
        globalMicRegistry.current = null;
      }
    };
  });

  // When the global mic finalizes speech, send it to the UI agent head-less.
  const onFinal = useCallback(
    (text: string, _meta: FinalMeta) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      awaitingExchange.current = true;
      void sendUiAgent(trimmed, { reveal: false });
    },
    [sendUiAgent],
  );

  // Surface a finished UI-agent exchange (only the one WE triggered) in the toast.
  useEffect(() => {
    if (!awaitingExchange.current || !lastUiExchange) {
      return;
    }
    awaitingExchange.current = false;
    showToast({
      id: lastUiExchange.id,
      transcript: lastUiExchange.transcript,
      reply:
        lastUiExchange.reply ||
        (lastUiExchange.ok ? 'Done.' : 'Something went wrong.'),
      ok: lastUiExchange.ok,
      isError: false,
    });
  }, [lastUiExchange, showToast]);

  // A mic/transport error (e.g. insecure origin needs HTTPS) goes to the toast.
  const onMicError = useCallback(
    (error: string | null) => {
      if (error) {
        showToast({
          id: `err-${Date.now().toString(36)}`,
          transcript: '',
          reply: error,
          ok: false,
          isError: true,
        });
      }
    },
    [showToast],
  );

  // Tapping a (non-error) toast opens the chat on the UI agent with the exchange
  // already in the thread, so the user can continue it there.
  const openInChat = useCallback(() => {
    if (toast?.isError) {
      return;
    }
    dismissToast();
    // reveal (not switchMode): the spoken exchange is already in the shared UI
    // thread, and switchMode('ui') would reset it to an empty conversation.
    revealUiChat();
  }, [toast, dismissToast, revealUiChat]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) {
      return;
    }
    setSwipeDx((e.touches[0]?.clientX ?? touchStartX.current) - touchStartX.current);
  }, []);
  const onTouchEnd = useCallback(() => {
    if (Math.abs(swipeDx) >= SWIPE_DISMISS_PX) {
      dismissToast();
    } else {
      setSwipeDx(0);
    }
    touchStartX.current = null;
  }, [swipeDx, dismissToast]);

  if (!settings.showVoiceButton) {
    return null;
  }

  return (
    <div className={`global-mic${settings.showChatButton ? '' : ' no-chat'}`}>
      {toast && (
        <div
          className={`global-mic-toast${toast.isError ? ' error' : ''}`}
          role={toast.isError ? 'alert' : 'status'}
          aria-live="polite"
          style={swipeDx ? { transform: `translateX(${swipeDx}px)`, opacity: 0.6 } : undefined}
          onClick={openInChat}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <button
            type="button"
            className="global-mic-toast-close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast();
            }}
          >
            <i className="pi pi-times" aria-hidden="true" />
          </button>
          {toast.transcript && (
            <p className="global-mic-toast-transcript" title={toast.transcript}>
              <i className="pi pi-microphone" aria-hidden="true" /> {toast.transcript}
            </p>
          )}
          <p className="global-mic-toast-reply">{toast.reply}</p>
          {!toast.isError && (
            <span className="global-mic-toast-hint">Tap to open in chat</span>
          )}
        </div>
      )}

      <MicButton
        ref={micRef}
        variant="global"
        onFinal={onFinal}
        scope="ui"
        language={voiceLang}
        busy={streaming}
        disabled={streaming}
        captureShortcuts={false}
        hideInlineError
        onError={onMicError}
        label="Talk to the assistant"
      />
    </div>
  );
}
