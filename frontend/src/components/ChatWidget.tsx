import { Button } from 'primereact/button';
import { InputTextarea } from 'primereact/inputtextarea';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useChat } from '../chat/ChatProvider';
import { type ChatMessage } from '../chat/chatState';
import { renderMarkdown } from '../chat/markdown';
import type { FinalMeta } from '../chat/useVoiceInput';
import { MicButton, type MicHandle } from './MicButton';
import './ChatWidget.css';

/** The two chat agents the widget switches between. */
type AgentMode = 'library' | 'ui';

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

/**
 * The floating chat panel.
 *
 * The chat/UI-agent STATE lives in {@link useChat} (the shared ChatProvider), so
 * the global microphone on the main view drives the same UI-agent thread and
 * client. This widget owns only the panel's own view state: the text input, the
 * scroll position, and the in-panel mic. Its mic exposes a {@link MicHandle} so
 * the shell can route `Ctrl+M` to it while the panel is open.
 */
export function ChatWidget() {
  const {
    open,
    setOpen,
    mode,
    switchMode,
    voiceLang,
    setVoiceLang,
    state,
    streaming,
    send,
    stop,
    newChat,
  } = useChat();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const micRef = useRef<MicHandle | null>(null);

  // onFinal from the mic: a VAD end-of-speech sends immediately; a manual stop
  // drops the text into the input box for the user to review.
  const onFinalTranscript = useCallback(
    (text: string, meta: FinalMeta) => {
      if (meta.autoSend) {
        void send(text);
        return;
      }
      setInput((prev) => (prev ? `${prev} ${text}`.replace(/\s+/g, ' ') : text));
      inputRef.current?.focus();
    },
    [send],
  );

  // Expose the open panel's mic to the shell so Ctrl+M routes here when open.
  useEffect(() => {
    const el = chatMicRegistry;
    el.current = open ? micRef.current : null;
    return () => {
      if (el.current === micRef.current) {
        el.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.messages, open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const submit = useCallback(
    (text: string) => {
      setInput('');
      void send(text);
    },
    [send],
  );

  const empty = state.messages.length === 0;
  const title = mode === 'ui' ? 'UI agent' : 'Library agent';

  return (
    <>
      <Button
        className="chat-fab"
        icon="pi pi-comments"
        rounded
        aria-label={open ? 'Close chat' : 'Open assistant'}
        onClick={() => setOpen(!open)}
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
                      onClick={() => submit(p)}
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
              onClick={() => setVoiceLang(voiceLang === 'pl-PL' ? 'en-US' : 'pl-PL')}
            >
              {voiceLang === 'pl-PL' ? 'PL' : 'EN'}
            </button>
            <MicButton
              ref={micRef}
              onFinal={onFinalTranscript}
              scope={mode}
              language={voiceLang}
              disabled={streaming}
              busy={streaming}
              captureShortcuts={false}
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
                onClick={() => submit(input)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A module-level handle to the OPEN panel's mic, so the shell's single Ctrl+M
 * listener can toggle the chat mic when the panel is open and the global mic
 * when it is closed, without either mic owning the shortcut (which would
 * double-fire). The widget publishes its mic here only while open.
 */
export const chatMicRegistry: { current: MicHandle | null } = { current: null };
