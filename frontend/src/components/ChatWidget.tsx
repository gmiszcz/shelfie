import { Button } from 'primereact/button';
import { InputTextarea } from 'primereact/inputtextarea';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { runAgent, type AgUiMessage } from '../agui/client';
import { describeAction } from '../agui/labels';
import { createTools } from '../agui/tools';
import { api } from '../services/api';
import { type ChatMessage, chatReducer, initialChatState } from '../chat/chatState';
import { renderMarkdown } from '../chat/markdown';
import { readChatStream } from '../chat/sse';
import type { FinalMeta, TranscriptLanguage } from '../chat/useVoiceInput';
import { MicButton } from './MicButton';
import type { Book, ChatEvent } from '../types';
import './ChatWidget.css';

/** The two chat agents the widget switches between. */
type AgentMode = 'library' | 'ui';

const SESSION_KEY = 'shelfie.chat.sessionId';
const MODE_KEY = 'shelfie.chat.mode';
const LANG_KEY = 'shelfie.chat.voiceLang';

/** Human labels for the LIBRARY agent's backend data tools. */
const TOOL_LABELS: Record<string, string> = {
  search_library: 'Searching your library',
  list_books: 'Listing books',
  get_book_details: 'Reading book details',
  reading_stats: 'Computing statistics',
  library_overview: 'Library overview',
};

const EXAMPLE_PROMPTS: Record<AgentMode, string[]> = {
  library: [
    'How many books have I finished this year?',
    'Recommend something from my unread shelf',
    'Which author do I own the most of?',
  ],
  ui: [
    'Pokaż książki z serii Droga Szamana',
    'Pokaż tylko 5 gwiazdek',
    'Przejdź do rankingu',
  ],
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Collapsible reasoning block: expanded while streaming, auto-collapses when done. */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true);
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      setOpen(false);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  if (!text) {
    return null;
  }
  return (
    <div className="chat-reasoning">
      <button type="button" className="chat-reasoning-toggle" onClick={() => setOpen((o) => !o)}>
        <i className={`pi ${open ? 'pi-chevron-down' : 'pi-chevron-right'}`} />
        <span>Thinking{streaming ? '…' : ''}</span>
      </button>
      {open && <div className="chat-reasoning-body">{text}</div>}
    </div>
  );
}

function ToolChip({ name, status }: { name: string; status: 'running' | 'success' | 'error' }) {
  const icon =
    status === 'running'
      ? 'pi pi-spin pi-spinner'
      : status === 'success'
        ? 'pi pi-check'
        : 'pi pi-times';
  return (
    <span className={`chat-tool-chip ${status}`}>
      <i className={`pi ${icon}`} />
      <span>{toolLabel(name)}</span>
    </span>
  );
}

/** A small card for a UI-agent action executed in the browser. */
function ActionCard({
  label,
  status,
}: {
  label: string;
  status: 'running' | 'success' | 'error';
}) {
  const icon =
    status === 'running'
      ? 'pi pi-spin pi-spinner'
      : status === 'success'
        ? 'pi pi-bolt'
        : 'pi pi-times';
  return (
    <div className={`chat-ui-action ${status}`} role="status">
      <i className={`pi ${icon}`} />
      <span>{label}</span>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const streaming = message.status === 'streaming';

  if (isUser) {
    return (
      <div className="chat-row user">
        <div className="chat-bubble user">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="chat-row assistant">
      <div className={`chat-bubble assistant ${message.status}`}>
        <ReasoningBlock text={message.reasoning} streaming={streaming} />

        {message.tools.length > 0 && (
          <div className="chat-tools">
            {message.tools.map((t) => (
              <ToolChip key={t.id} name={t.name} status={t.status} />
            ))}
          </div>
        )}

        {message.actions.length > 0 && (
          <div className="chat-ui-actions">
            {message.actions.map((a) => (
              <ActionCard key={a.id} label={a.label ?? a.name} status={a.status} />
            ))}
          </div>
        )}

        {message.status === 'error' ? (
          <div className="chat-error">
            <i className="pi pi-exclamation-triangle" />
            <span>{message.error ?? 'Something went wrong.'}</span>
          </div>
        ) : streaming ? (
          <div className="chat-stream-text">
            {message.text}
            <span className="chat-caret" />
          </div>
        ) : (
          <div className="chat-markdown">{renderMarkdown(message.text)}</div>
        )}
      </div>
    </div>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The UI agent keeps the full conversation (AG-UI messages) across turns, and
  // a cache of the loaded books for its browser-side find_books tool.
  const uiMessagesRef = useRef<AgUiMessage[]>([]);
  const booksRef = useRef<Book[]>([]);

  // onFinal from the mic: a VAD end-of-speech sends immediately; a manual stop
  // drops the text into the input box for the user to review.
  const sendRef = useRef<(raw: string) => void>(() => {});
  const onFinalTranscript = useCallback((text: string, meta: FinalMeta) => {
    if (meta.autoSend) {
      sendRef.current(text);
      return;
    }
    setInput((prev) => (prev ? `${prev} ${text}`.replace(/\s+/g, ' ') : text));
    inputRef.current?.focus();
  }, []);

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

  // Keep a fresh book list for the UI agent's find_books tool while in UI mode.
  useEffect(() => {
    if (mode !== 'ui' || !open) {
      return;
    }
    let cancelled = false;
    void api
      .listBooks()
      .then((books) => {
        if (!cancelled) {
          booksRef.current = books;
        }
      })
      .catch(() => {
        // find_books degrades to "no books loaded"; the agent reports it.
      });
    return () => {
      cancelled = true;
    };
  }, [mode, open]);

  // Library agent: dispatch each backend wire event into the reducer.
  const handleLibraryEvent = useCallback((event: ChatEvent) => {
    dispatch({ type: 'event', event });
  }, []);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.messages, open]);

  /** Run the LIBRARY agent (existing backend strands-compose over SSE). */
  const sendLibrary = useCallback(
    async (text: string, controller: AbortController) => {
      const resp = await api.chat(text, sessionRef.current, 'library', controller.signal);
      await readChatStream(resp, handleLibraryEvent, controller.signal);
    },
    [handleLibraryEvent],
  );

  /** Run the UI agent (browser-side frontend-tools loop). */
  const sendUi = useCallback(async (text: string, controller: AbortController) => {
    const tools = createTools({ getBooks: () => booksRef.current });
    const history = uiMessagesRef.current;
    history.push({ role: 'user', content: text });

    const result = await runAgent({
      threadId: sessionRef.current ?? (sessionRef.current = newId('t')),
      messages: history,
      tools,
      signal: controller.signal,
      callbacks: {
        onTextDelta: (delta) => dispatch({ type: 'text_delta', text: delta }),
        onToolCall: (call) =>
          dispatch({
            type: 'action_start',
            id: call.id,
            name: call.name,
            label: describeAction(call.name, call.args),
            args: call.args,
          }),
        onToolResult: (id, _result, ok) => dispatch({ type: 'action_result', id, ok }),
        onError: (message) => dispatch({ type: 'error', message }),
        onRunFinish: () => dispatch({ type: 'finish', ok: true }),
      },
    });

    // Persist the full conversation (assistant + tool turns) for the next message.
    uiMessagesRef.current = result.messages;
    if (result.error) {
      dispatch({ type: 'finish', ok: false, error: result.error });
    } else {
      dispatch({ type: 'finish', ok: true });
    }
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || streaming) {
        return;
      }
      setInput('');
      dispatch({ type: 'send', text, userId: newId('u'), assistantId: newId('a') });
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        if (mode === 'ui') {
          await sendUi(text, controller);
        } else {
          await sendLibrary(text, controller);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          dispatch({ type: 'finish', ok: true });
        } else {
          const message = err instanceof Error ? err.message : 'Request failed';
          dispatch({ type: 'error', message });
          dispatch({ type: 'finish', ok: false, error: message });
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setStreaming(false);
      }
    },
    [streaming, mode, sendUi, sendLibrary],
  );
  sendRef.current = (raw: string) => void send(raw);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Ctrl+M opens the chat when it is closed; MicButton's own window-level
  // handler then toggles recording once the panel (and the hook) are mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'm' || e.key === 'M') && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const newChat = useCallback(async () => {
    stop();
    const current = sessionRef.current;
    const wasLibrary = mode === 'library';
    dispatch({ type: 'reset' });
    sessionRef.current = null;
    uiMessagesRef.current = [];
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    // Only the library agent has server-side session state to reset.
    if (current && wasLibrary) {
      try {
        await api.resetChat(current);
      } catch {
        // best-effort
      }
    }
  }, [stop, mode]);

  // Switching agents starts a clean conversation (their histories differ).
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const empty = state.messages.length === 0;
  const title = mode === 'ui' ? 'UI agent' : 'Library agent';

  return (
    <>
      <Button
        className="chat-fab"
        icon="pi pi-comments"
        rounded
        aria-label={open ? 'Close chat' : 'Open assistant'}
        onClick={() => setOpen((o) => !o)}
      />

      {open && (
        <div className="chat-panel" role="dialog" aria-label="Shelfie assistant">
          <header className="chat-header">
            <span className="chat-title">
              <i className={`pi ${mode === 'ui' ? 'pi-desktop' : 'pi-book'}`} /> {title}
            </span>
            <span className="chat-header-actions">
              <Button
                icon="pi pi-plus"
                text
                rounded
                aria-label="New chat"
                onClick={() => void newChat()}
              />
              <Button
                icon="pi pi-times"
                text
                rounded
                aria-label="Close"
                onClick={() => setOpen(false)}
              />
            </span>
          </header>

          <div className="chat-mode-switch" role="tablist" aria-label="Agent mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'library'}
              className={`chat-mode-btn ${mode === 'library' ? 'active' : ''}`}
              onClick={() => switchMode('library')}
            >
              <i className="pi pi-book" />
              <span>Library agent</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'ui'}
              className={`chat-mode-btn ${mode === 'ui' ? 'active' : ''}`}
              onClick={() => switchMode('ui')}
            >
              <i className="pi pi-desktop" />
              <span>UI agent</span>
            </button>
          </div>

          <div className="chat-scroll" ref={scrollRef}>
            {empty ? (
              <div className="chat-empty">
                <i className="pi pi-sparkles" />
                <p>
                  {mode === 'ui'
                    ? 'Ask me to filter, open, add or navigate — I drive the interface.'
                    : 'Ask about your books, reading stats or recommendations.'}
                </p>
                <div className="chat-examples">
                  {EXAMPLE_PROMPTS[mode].map((p) => (
                    <button
                      type="button"
                      key={p}
                      className="chat-example"
                      onClick={() => void send(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              state.messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
          </div>

          <div className="chat-input">
            <button
              type="button"
              className="chat-lang-toggle"
              aria-label={`Voice language: ${voiceLang === 'pl-PL' ? 'Polish' : 'English'}. Click to switch.`}
              title={`Voice language: ${voiceLang === 'pl-PL' ? 'Polish' : 'English'}`}
              disabled={streaming}
              onClick={() => setVoiceLang((l) => (l === 'pl-PL' ? 'en-US' : 'pl-PL'))}
            >
              {voiceLang === 'pl-PL' ? 'PL' : 'EN'}
            </button>
            <MicButton
              onFinal={onFinalTranscript}
              scope={mode}
              language={voiceLang}
              disabled={streaming}
            />
            <InputTextarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={mode === 'ui' ? 'Tell me what to do…' : 'Message the assistant…'}
              autoResize
              rows={1}
              className="chat-textarea"
            />
            {streaming ? (
              <Button
                icon="pi pi-stop"
                rounded
                severity="danger"
                aria-label="Stop"
                onClick={stop}
              />
            ) : (
              <Button
                icon="pi pi-send"
                rounded
                aria-label="Send"
                disabled={!input.trim()}
                onClick={() => void send(input)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
