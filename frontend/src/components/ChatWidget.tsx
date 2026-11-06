import { Button } from 'primereact/button';
import { InputTextarea } from 'primereact/inputtextarea';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { dispatchUiAction } from '../agui/uiBus';
import { api } from '../services/api';
import { type ChatMessage, chatReducer, initialChatState } from '../chat/chatState';
import { renderMarkdown } from '../chat/markdown';
import { readChatStream } from '../chat/sse';
import type { FinalMeta, TranscriptLanguage } from '../chat/useVoiceInput';
import { MicButton } from './MicButton';
import type { ChatEvent, ChatScope } from '../types';
import './ChatWidget.css';

const SESSION_KEY = 'shelfie.chat.sessionId';
const SCOPE_KEY = 'shelfie.chat.scope';
const LANG_KEY = 'shelfie.chat.voiceLang';

/** Human labels for the agent's tools, keyed by tool name. */
const TOOL_LABELS: Record<string, string> = {
  search_library: 'Searching your library',
  list_books: 'Listing books',
  get_book_details: 'Reading book details',
  reading_stats: 'Computing statistics',
  library_overview: 'Library overview',
};

const EXAMPLE_PROMPTS = [
  'How many books have I finished this year?',
  'Recommend something from my unread shelf',
  'Which author do I own the most of?',
];

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
    // Auto-collapse once the turn stops streaming.
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

        {message.uiActions.length > 0 && (
          <div className="chat-ui-actions">
            {message.uiActions.map((a) => (
              <div key={a.id} className="chat-ui-action" role="status">
                <i className="pi pi-bolt" />
                <span>
                  Action: <strong>{a.label}</strong>
                </span>
              </div>
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
  const [scope, setScope] = useState<ChatScope>(() => {
    const saved = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SCOPE_KEY) : null;
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

  // Persist scope and voice language.
  useEffect(() => {
    try {
      sessionStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // ignore
    }
  }, [scope]);
  useEffect(() => {
    try {
      sessionStorage.setItem(LANG_KEY, voiceLang);
    } catch {
      // ignore
    }
  }, [voiceLang]);

  // Dispatch a UI tool call onto the shelfie:ui bus as it streams in (the pure
  // reducer records the "Action" card; the side-effect belongs here).
  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'tool_end' && event.ui_action) {
      dispatchUiAction(event.name, event.input);
    }
    dispatch({ type: 'event', event });
  }, []);

  // Persist the session id whenever the reducer learns a new one.
  useEffect(() => {
    if (state.sessionId) {
      sessionRef.current = state.sessionId;
      try {
        sessionStorage.setItem(SESSION_KEY, state.sessionId);
      } catch {
        // sessionStorage unavailable: keep the in-memory ref only.
      }
    }
  }, [state.sessionId]);

  // Auto-scroll to the newest content on any change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.messages, open]);

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
        const resp = await api.chat(text, sessionRef.current, scope, controller.signal);
        await readChatStream(resp, handleEvent, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          // Deliberate Stop: close the stream quietly as a finished turn.
          dispatch({ type: 'event', event: { type: 'session_finish', text: '', ok: true } });
        } else {
          const message = err instanceof Error ? err.message : 'Request failed';
          dispatch({ type: 'event', event: { type: 'error', message } });
          dispatch({ type: 'event', event: { type: 'session_finish', text: '', ok: false } });
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setStreaming(false);
      }
    },
    [streaming, scope, handleEvent],
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
    dispatch({ type: 'reset' });
    sessionRef.current = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
    if (current) {
      try {
        await api.resetChat(current);
      } catch {
        // Resetting server state is best-effort; the local chat is already cleared.
      }
    }
  }, [stop]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const empty = state.messages.length === 0;

  return (
    <>
      <Button
        className="chat-fab"
        icon="pi pi-comments"
        rounded
        aria-label={open ? 'Close chat' : 'Open library assistant'}
        onClick={() => setOpen((o) => !o)}
      />

      {open && (
        <div className="chat-panel" role="dialog" aria-label="Library assistant">
          <header className="chat-header">
            <span className="chat-title">
              <i className="pi pi-comments" /> Library assistant
            </span>
            <span className="chat-header-actions">
              <button
                type="button"
                className={`chat-scope-toggle ${scope}`}
                role="switch"
                aria-checked={scope === 'ui'}
                aria-label={
                  scope === 'ui'
                    ? 'UI control on: the assistant can drive the interface. Click for library only.'
                    : 'Library only. Click to let the assistant control the UI.'
                }
                title={scope === 'ui' ? 'Library + UI control' : 'Library only'}
                onClick={() => setScope((s) => (s === 'ui' ? 'library' : 'ui'))}
              >
                <i className={`pi ${scope === 'ui' ? 'pi-desktop' : 'pi-book'}`} />
                <span>{scope === 'ui' ? 'Library + UI control' : 'Library only'}</span>
              </button>
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

          <div className="chat-scroll" ref={scrollRef}>
            {empty ? (
              <div className="chat-empty">
                <i className="pi pi-sparkles" />
                <p>Ask about your books, reading stats or recommendations.</p>
                <div className="chat-examples">
                  {EXAMPLE_PROMPTS.map((p) => (
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
              scope={scope}
              language={voiceLang}
              disabled={streaming}
            />
            <InputTextarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message the assistant…"
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
