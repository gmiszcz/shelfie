export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'done' | 'error';
export type ToolStatus = 'running' | 'success' | 'error';

/** A data-tool chip (library agent) or an action card (UI agent). */
export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  /** For UI-agent action cards: a short human label and the call arguments. */
  label?: string;
  args?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  reasoning: string;
  /** Data-tool chips (library agent). */
  tools: ToolCall[];
  /** UI action cards (UI agent): the tools it executed in the browser. */
  actions: ToolCall[];
  status: MessageStatus;
  error?: string;
}

export interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
}

export type ChatAction =
  | { type: 'send'; text: string; userId: string; assistantId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'action_start'; id: string; name: string; label: string; args: Record<string, unknown> }
  | { type: 'action_label'; id: string; label: string; args: Record<string, unknown> }
  | { type: 'action_result'; id: string; ok: boolean }
  | { type: 'finish'; ok: boolean; error?: string }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
};

function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' ? last : undefined;
}

function patchLastAssistant(
  state: ChatState,
  update: (msg: ChatMessage) => ChatMessage,
): ChatState {
  const target = lastAssistant(state.messages);
  if (!target) {
    return state;
  }
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === target.id ? update(m) : m)),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { ...initialChatState };

    case 'send': {
      const userMsg: ChatMessage = {
        id: action.userId,
        role: 'user',
        text: action.text,
        reasoning: '',
        tools: [],
        actions: [],
        status: 'done',
      };
      const assistantMsg: ChatMessage = {
        id: action.assistantId,
        role: 'assistant',
        text: '',
        reasoning: '',
        tools: [],
        actions: [],
        status: 'streaming',
      };
      return { ...state, messages: [...state.messages, userMsg, assistantMsg] };
    }

    // --- UI agent (browser-side) ---------------------------------------------
    case 'text_delta':
      return patchLastAssistant(state, (m) => ({ ...m, text: m.text + action.text }));

    case 'action_start':
      return patchLastAssistant(state, (m) => ({
        ...m,
        actions: [
          ...m.actions,
          { id: action.id, name: action.name, label: action.label, args: action.args, status: 'running' },
        ],
      }));

    case 'action_label':
      return patchLastAssistant(state, (m) => ({
        ...m,
        actions: m.actions.map((a) =>
          a.id === action.id ? { ...a, label: action.label, args: action.args } : a,
        ),
      }));

    case 'reasoning_delta':
      return patchLastAssistant(state, (m) => ({ ...m, reasoning: m.reasoning + action.text }));

    case 'tool_start':
      return patchLastAssistant(state, (m) => ({
        ...m,
        tools: [...m.tools, { id: action.id, name: action.name, status: 'running' }],
      }));

    case 'action_result': {
      // One result action for both kinds: a server data tool chip or a browser action card.
      const status: ToolStatus = action.ok ? 'success' : 'error';
      return patchLastAssistant(state, (m) => ({
        ...m,
        tools: m.tools.map((t) => (t.id === action.id ? { ...t, status } : t)),
        actions: m.actions.map((a) => (a.id === action.id ? { ...a, status } : a)),
      }));
    }

    case 'finish':
      return patchLastAssistant(state, (m) => ({
        ...m,
        status: action.ok && m.status !== 'error' ? 'done' : 'error',
        error: action.error ?? m.error,
      }));

    case 'error':
      return patchLastAssistant(state, (m) => ({
        ...m,
        status: 'error',
        error: action.message,
      }));

    default:
      return state;
  }
}
