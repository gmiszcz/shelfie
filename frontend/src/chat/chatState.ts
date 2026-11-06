import type { ChatEvent, UiBusDetail } from '../types';
import { describeUiAction, toUiBusDetail } from '../agui/uiBus';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'done' | 'error';
export type ToolStatus = 'running' | 'success' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
}

/** A UI action the agent performed this turn, shown as an "Action" card. */
export interface UiAction {
  id: string;
  detail: UiBusDetail;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  reasoning: string;
  tools: ToolCall[];
  uiActions: UiAction[];
  status: MessageStatus;
  error?: string;
}

export interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
}

export type ChatAction =
  | { type: 'send'; text: string; userId: string; assistantId: string }
  | { type: 'event'; event: ChatEvent }
  | { type: 'reset' };

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
};

/** The last message, which during a turn is the streaming assistant message. */
function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' ? last : undefined;
}

/** Replace the last assistant message with the result of `update`. */
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
        uiActions: [],
        status: 'done',
      };
      const assistantMsg: ChatMessage = {
        id: action.assistantId,
        role: 'assistant',
        text: '',
        reasoning: '',
        tools: [],
        uiActions: [],
        status: 'streaming',
      };
      return { ...state, messages: [...state.messages, userMsg, assistantMsg] };
    }

    case 'event': {
      const event = action.event;
      switch (event.type) {
        case 'session_start':
          return { ...state, sessionId: event.session_id };

        case 'reasoning':
          return patchLastAssistant(state, (m) => ({
            ...m,
            reasoning: m.reasoning + event.text,
          }));

        case 'token':
          return patchLastAssistant(state, (m) => ({ ...m, text: m.text + event.text }));

        case 'tool_start':
          // A UI (frontend) tool is shown as an "Action" card on tool_end, not
          // as a running data-tool chip.
          if (event.ui_action) {
            return state;
          }
          return patchLastAssistant(state, (m) => ({
            ...m,
            tools: [...m.tools, { id: event.id, name: event.name, status: 'running' }],
          }));

        case 'tool_args':
          // AG-UI TOOL_CALL_ARGS: arguments are carried again on tool_end, so
          // nothing to accumulate here for the current UI.
          return state;

        case 'tool_end':
          return patchLastAssistant(state, (m) => {
            // UI tool: append a UI action card (dispatching to the bus happens
            // in the ChatWidget event handler, not in this pure reducer).
            if (event.ui_action) {
              const detail = toUiBusDetail(event.name, event.input);
              if (!detail) {
                return m;
              }
              return {
                ...m,
                uiActions: [
                  ...m.uiActions,
                  { id: event.id, detail, label: describeUiAction(detail) },
                ],
              };
            }
            const nextStatus: ToolStatus = event.status === 'error' ? 'error' : 'success';
            let matched = false;
            const tools = m.tools.map((t) => {
              if (!matched && t.id === event.id && t.status === 'running') {
                matched = true;
                return { ...t, status: nextStatus };
              }
              return t;
            });
            if (!matched) {
              // tool_end without a matching start: record it as a finished tool.
              tools.push({ id: event.id, name: event.name, status: nextStatus });
            }
            return { ...m, tools };
          });

        case 'error':
          return patchLastAssistant(state, (m) => ({
            ...m,
            status: 'error',
            error: event.message,
          }));

        case 'session_finish':
          return patchLastAssistant(state, (m) => ({
            ...m,
            text: event.text ? event.text : m.text,
            status: m.status === 'error' || !event.ok ? 'error' : 'done',
          }));

        default:
          return state;
      }
    }

    default:
      return state;
  }
}
