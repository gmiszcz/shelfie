/**
 * The single source of truth for the chat + UI-agent conversation.
 *
 * Before this provider the whole chat (state, the AG-UI client, the UI-agent
 * thread, the open/closed panel) lived inside {@link ChatWidget}. The global
 * microphone (outside the chat) needs to drive the SAME UI agent — one thread,
 * one client, one reducer — without opening the panel, and tapping its toast
 * must open the chat already showing that exchange. So the state is lifted here
 * and both the widget and the global mic consume it.
 *
 * What lives here:
 *   - `open` / `setOpen` — whether the chat panel is visible;
 *   - `mode` — library vs UI agent (persisted);
 *   - `voiceLang` — the PL/EN voice language shared by every mic (persisted);
 *   - the chat reducer `state` + `dispatch`;
 *   - `sendUi(text, { reveal })` — run the UNIVERSAL UI agent over the shared
 *     thread. `reveal: false` (the global mic) runs it without opening the panel;
 *     the widget passes `reveal: true` implicitly by being open already.
 *   - `sendLibrary` / `send` — the widget's normal send (mode-aware);
 *   - `lastUiExchange` — the most recent user+assistant UI-agent turn, so the
 *     global mic's toast can show it and reveal it on tap.
 *
 * Only the UI agent is driven head-less (it acts on the interface); the library
 * agent is only ever used from the open panel.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { runAgent, type AgUiMessage } from '../agui/client';
import { describeAction } from '../agui/labels';
import { createTools } from '../agui/tools';
import { api } from '../services/api';
import type { Book, ChatEvent } from '../types';
import { readChatStream } from './sse';
import { chatReducer, initialChatState, type ChatState, type ChatAction } from './chatState';
import type { TranscriptLanguage } from './useVoiceInput';

export type AgentMode = 'library' | 'ui';

const SESSION_KEY = 'shelfie.chat.sessionId';
const MODE_KEY = 'shelfie.chat.mode';
const LANG_KEY = 'shelfie.chat.voiceLang';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep roughly the last N user turns' worth of messages in the UI-agent thread. */
const UI_HISTORY_KEEP_EXCHANGES = 6;

/**
 * Shrink the UI-agent conversation before a new command.
 *
 * The thread accumulates every turn forever, and each `tool` message holds a FULL
 * tool result — including whole `describe_ui` schema dumps — which are only useful
 * to the model while it is resolving the command that produced them. Re-sending all
 * of them every turn is the main driver of the "thinks much longer, then errors"
 * slowdown. So: keep the most recent exchanges verbatim, and in older turns replace
 * each tool result body with a short `[omitted]` marker. The messages (and their
 * toolCallIds) stay in place, so toolUse/toolResult pairing is never broken.
 */
function trimUiHistory(messages: AgUiMessage[]): AgUiMessage[] {
  // Find the cut point: the index of the Nth-from-last `user` message.
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIdx.push(i);
  });
  if (userIdx.length <= UI_HISTORY_KEEP_EXCHANGES) {
    return messages;
  }
  const cut = userIdx[userIdx.length - UI_HISTORY_KEEP_EXCHANGES];
  return messages.map((m, i) => {
    if (i >= cut || m.role !== 'tool') {
      return m;
    }
    // An old tool result: drop its (possibly huge) body but keep the pairing.
    return { ...m, content: '[omitted]' };
  });
}

/** One finished UI-agent turn, surfaced for the global mic's toast. */
export interface UiExchange {
  id: string;
  transcript: string;
  reply: string;
  ok: boolean;
}

export interface ChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: AgentMode;
  switchMode: (next: AgentMode) => void;
  voiceLang: TranscriptLanguage;
  setVoiceLang: (lang: TranscriptLanguage) => void;
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
  streaming: boolean;
  /** Send a message in the CURRENT panel mode (library or UI). Used by the widget. */
  send: (raw: string) => Promise<void>;
  /**
   * Run the UNIVERSAL UI agent over the shared thread. `reveal` opens the panel
   * (and switches it to UI mode) so the exchange is visible; the global mic
   * passes `reveal: false` to drive the UI without opening the chat.
   */
  sendUiAgent: (text: string, opts?: { reveal?: boolean }) => Promise<void>;
  /**
   * Open the chat panel on the UI agent WITHOUT resetting the thread — used by the
   * global mic's toast so tapping it reveals the exchange that was just spoken,
   * instead of `switchMode('ui')` which starts a clean conversation.
   */
  revealUiChat: () => void;
  stop: () => void;
  newChat: () => Promise<void>;
  /** The latest finished UI-agent turn, for the global mic toast. */
  lastUiExchange: UiExchange | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [streaming, setStreaming] = useState(false);
  const [lastUiExchange, setLastUiExchange] = useState<UiExchange | null>(null);
  const [mode, setMode] = useState<AgentMode>(() => {
    const saved = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(MODE_KEY) : null;
    return saved === 'ui' ? 'ui' : 'library';
  });
  const [voiceLang, setVoiceLang] = useState<TranscriptLanguage>(() => {
    const saved = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(LANG_KEY) : null;
    return saved === 'en-US' ? 'en-US' : 'pl-PL';
  });

  const sessionRef = useRef<string | null>(
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null,
  );
  const abortRef = useRef<AbortController | null>(null);
  // The UI agent keeps the full AG-UI conversation across turns, plus a cache of
  // the loaded books for its browser-side find_books tool.
  const uiMessagesRef = useRef<AgUiMessage[]>([]);
  const booksRef = useRef<Book[]>([]);

  useEffect(() => {
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);
  useEffect(() => {
    try {
      sessionStorage.setItem(LANG_KEY, voiceLang);
    } catch {
      // ignore
    }
  }, [voiceLang]);

  useEffect(() => {
    if (state.sessionId) {
      sessionRef.current = state.sessionId;
      try {
        sessionStorage.setItem(SESSION_KEY, state.sessionId);
      } catch {
        // ignore
      }
    }
  }, [state.sessionId]);

  // Keep a fresh book list for the UI agent's find_books tool. The global mic can
  // fire the UI agent while the panel is closed, so this must not depend on `open`
  // — load once on mount and whenever we are about to need it.
  const ensureBooks = useCallback(async () => {
    if (booksRef.current.length) {
      return;
    }
    try {
      booksRef.current = await api.listBooks();
    } catch {
      // find_books degrades to "no books loaded"; the agent reports it.
    }
  }, []);
  useEffect(() => {
    void ensureBooks();
  }, [ensureBooks]);

  const handleLibraryEvent = useCallback((event: ChatEvent) => {
    dispatch({ type: 'event', event });
  }, []);

  const sendLibrary = useCallback(
    async (text: string, controller: AbortController) => {
      const resp = await api.chat(text, sessionRef.current, 'library', controller.signal);
      await readChatStream(resp, handleLibraryEvent, controller.signal);
    },
    [handleLibraryEvent],
  );

  /** Run the UI agent over the shared thread, dispatching into the shared reducer. */
  const runUi = useCallback(async (text: string, controller: AbortController) => {
    await ensureBooks();
    const tools = createTools({
      getBooks: () => booksRef.current,
      series: { list: api.listSeries, get: api.getSeries, refresh: api.refreshSeries },
    });
    // Trim stale tool-result dumps from earlier commands before adding this one.
    const history = trimUiHistory(uiMessagesRef.current);
    uiMessagesRef.current = history;
    history.push({ role: 'user', content: text });

    const result = await runAgent({
      threadId: sessionRef.current ?? (sessionRef.current = newId('t')),
      messages: history,
      tools,
      signal: controller.signal,
      callbacks: {
        onTextDelta: (delta) => dispatch({ type: 'text_delta', text: delta }),
        // Show the action pill the instant the call starts (args not in yet), then
        // refine its label once the args are parsed (onToolCall).
        onToolCallStart: (call) =>
          dispatch({
            type: 'action_start',
            id: call.id,
            name: call.name,
            label: describeAction(call.name, {}),
            args: {},
          }),
        onToolCall: (call) =>
          dispatch({
            type: 'action_label',
            id: call.id,
            label: describeAction(call.name, call.args),
            args: call.args,
          }),
        onToolResult: (id, _result, ok) => dispatch({ type: 'action_result', id, ok }),
        onError: (message) => dispatch({ type: 'error', message }),
        onRunFinish: () => dispatch({ type: 'finish', ok: true }),
      },
    });

    uiMessagesRef.current = result.messages;
    if (result.error) {
      dispatch({ type: 'finish', ok: false, error: result.error });
      return { reply: result.finalText, ok: false, error: result.error };
    }
    dispatch({ type: 'finish', ok: true });
    return { reply: result.finalText, ok: true };
  }, [ensureBooks]);

  const runWithGuards = useCallback(
    async (text: string, runner: (t: string, c: AbortController) => Promise<unknown>) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      try {
        return await runner(text, controller);
      } catch (err) {
        if (controller.signal.aborted) {
          dispatch({ type: 'finish', ok: true });
        } else {
          const message = err instanceof Error ? err.message : 'Request failed';
          dispatch({ type: 'error', message });
          dispatch({ type: 'finish', ok: false, error: message });
        }
        return { reply: '', ok: false, error: 'Request failed' };
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setStreaming(false);
      }
    },
    [],
  );

  /** The widget's send: mode-aware (library or UI), always into the open panel. */
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || streaming) {
        return;
      }
      dispatch({ type: 'send', text, userId: newId('u'), assistantId: newId('a') });
      await runWithGuards(text, mode === 'ui' ? runUi : sendLibrary);
    },
    [streaming, mode, runUi, sendLibrary, runWithGuards],
  );

  /**
   * Drive the UI agent from anywhere (the global mic). It always targets the UI
   * agent regardless of the panel's current mode, appends the exchange to the
   * shared thread, and records it for the toast. `reveal` opens the panel on the
   * UI agent so the user sees the conversation.
   */
  const sendUiAgent = useCallback(
    async (raw: string, opts?: { reveal?: boolean }) => {
      const text = raw.trim();
      if (!text || streaming) {
        return;
      }
      if (opts?.reveal) {
        setMode('ui');
        setOpen(true);
      }
      dispatch({ type: 'send', text, userId: newId('u'), assistantId: newId('a') });
      const outcome = (await runWithGuards(text, runUi)) as {
        reply: string;
        ok: boolean;
      };
      setLastUiExchange({
        id: newId('ex'),
        transcript: text,
        reply: outcome.reply,
        ok: outcome.ok,
      });
    },
    [streaming, runUi, runWithGuards],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Reveal the UI-agent conversation (the global mic toast taps here). Switching
   * to UI mode must NOT reset: the head-less mic run already appended the exchange
   * to this same shared thread, so we only flip the panel to UI mode and open it.
   * `switchMode` is for the panel's own tabs, where a clean conversation is wanted.
   */
  const revealUiChat = useCallback(() => {
    setMode('ui');
    setOpen(true);
  }, []);

  const newChat = useCallback(async () => {
    stop();
    const current = sessionRef.current;
    const wasLibrary = mode === 'library';
    dispatch({ type: 'reset' });
    sessionRef.current = null;
    uiMessagesRef.current = [];
    setLastUiExchange(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    if (current && wasLibrary) {
      try {
        await api.resetChat(current);
      } catch {
        // best-effort
      }
    }
  }, [stop, mode]);

  // Switching agents in the panel starts a clean conversation (histories differ).
  const switchMode = useCallback(
    (next: AgentMode) => {
      if (next === mode) {
        return;
      }
      setMode(next);
      void newChat();
    },
    [mode, newChat],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      open,
      setOpen,
      mode,
      switchMode,
      voiceLang,
      setVoiceLang,
      state,
      dispatch,
      streaming,
      send,
      sendUiAgent,
      revealUiChat,
      stop,
      newChat,
      lastUiExchange,
    }),
    [
      open,
      mode,
      switchMode,
      voiceLang,
      state,
      streaming,
      send,
      sendUiAgent,
      revealUiChat,
      stop,
      newChat,
      lastUiExchange,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
