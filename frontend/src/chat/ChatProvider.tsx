/**
 * The single source of truth for the assistant conversation.
 *
 * There is ONE assistant (the librarian on the server, see app/agent/config.yaml) and
 * ONE AG-UI thread. The chat panel and the global microphone both send into it, so
 * a spoken command shows up in the chat. The AG-UI loop itself is in `../agui/agent`.
 *
 * What lives here:
 *   - `open` / `setOpen` - whether the chat panel is visible;
 *   - `voiceLang` - the PL/EN voice language shared by every mic (persisted);
 *   - the chat reducer `state`;
 *   - `send(text, { reveal })` - ask the assistant. The panel sends with the default
 *     (no reveal needed, it is open); the global mic passes `reveal: false` to drive
 *     the app without opening the panel;
 *   - `lastExchange` - the latest finished turn, for the global mic's toast.
 */

import type { HttpAgent } from '@ag-ui/client';
import { useQueryClient } from '@tanstack/react-query';
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

import { ask, forgetThread, newAgent } from '../agui/agent';
import { describeAction } from '../agui/labels';
import { queryKeys, useQueryUserId } from '../queries';
import { chatReducer, initialChatState, type ChatAction, type ChatState } from './chatState';
import type { TranscriptLanguage } from './useVoiceInput';

const LANG_KEY = 'shelfie.chat.voiceLang';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One finished turn, surfaced for the global mic's toast. */
export interface Exchange {
  id: string;
  transcript: string;
  reply: string;
  ok: boolean;
}

export interface ChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  voiceLang: TranscriptLanguage;
  setVoiceLang: (lang: TranscriptLanguage) => void;
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
  streaming: boolean;
  /** Ask the assistant. `reveal` opens the panel so the exchange is visible. */
  send: (text: string, opts?: { reveal?: boolean }) => Promise<void>;
  stop: () => void;
  newChat: () => Promise<void>;
  /** The latest finished turn, for the global mic toast. */
  lastExchange: Exchange | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [streaming, setStreaming] = useState(false);
  const [lastExchange, setLastExchange] = useState<Exchange | null>(null);
  const [voiceLang, setVoiceLang] = useState<TranscriptLanguage>(() => {
    const saved = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(LANG_KEY) : null;
    return saved === 'en-US' ? 'en-US' : 'pl-PL';
  });
  const agentRef = useRef<HttpAgent | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(LANG_KEY, voiceLang);
    } catch {
      // ignore
    }
  }, [voiceLang]);

  const queryClient = useQueryClient();
  const queryUserId = useQueryUserId();

  const send = useCallback(
    async (raw: string, opts?: { reveal?: boolean }) => {
      const text = raw.trim();
      if (!text || streaming) return;
      if (opts?.reveal) setOpen(true);
      agentRef.current ??= newAgent();
      dispatch({ type: 'send', text, userId: newId('u'), assistantId: newId('a') });
      setStreaming(true);
      let ok = true;
      let reply = '';
      try {
        reply = await ask(agentRef.current, text, {
          onText: (delta) => dispatch({ type: 'text_delta', text: delta }),
          onReasoning: (delta) => dispatch({ type: 'reasoning_delta', text: delta }),
          onToolCall: (id, name, browser) =>
            dispatch(
              browser
                ? { type: 'action_start', id, name, label: describeAction(name, {}), args: {} }
                : { type: 'tool_start', id, name },
            ),
          onToolArgs: (id, name, args) =>
            dispatch({ type: 'action_label', id, label: describeAction(name, args), args }),
          onToolResult: (id, success) => dispatch({ type: 'action_result', id, ok: success }),
          onError: (message) => {
            ok = false;
            dispatch({ type: 'error', message });
          },
        });
      } finally {
        dispatch({ type: 'finish', ok });
        setStreaming(false);
        // The assistant may have changed data on the server (add_book, update_book, ...).
        // Refetch this user's data; unchanged lists answer 304 via ETag, so it is cheap.
        void queryClient.invalidateQueries({ queryKey: queryKeys.user(queryUserId) });
      }
      setLastExchange({ id: newId('ex'), transcript: text, reply, ok });
    },
    [streaming, queryClient, queryUserId],
  );

  const stop = useCallback(() => {
    agentRef.current?.abortRun();
  }, []);

  const newChat = useCallback(async () => {
    const agent = agentRef.current;
    agent?.abortRun();
    agentRef.current = null;
    dispatch({ type: 'reset' });
    setLastExchange(null);
    if (agent) {
      try {
        await forgetThread(agent.threadId);
      } catch {
        // best-effort
      }
    }
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      open,
      setOpen,
      voiceLang,
      setVoiceLang,
      state,
      dispatch,
      streaming,
      send,
      stop,
      newChat,
      lastExchange,
    }),
    [open, voiceLang, state, streaming, send, stop, newChat, lastExchange],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within a ChatProvider');
  return ctx;
}
