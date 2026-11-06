import { describe, expect, it } from 'vitest';

import type { ChatEvent } from '../types';
import { type ChatState, chatReducer, initialChatState } from './chatState';

function send(state: ChatState, text: string): ChatState {
  return chatReducer(state, { type: 'send', text, userId: 'u1', assistantId: 'a1' });
}

function feed(state: ChatState, events: ChatEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: 'event', event }), state);
}

describe('chatReducer', () => {
  it('send adds a user message and an empty streaming assistant message', () => {
    const state = send(initialChatState, 'Ile mam książek?');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: 'user', text: 'Ile mam książek?', status: 'done' });
    expect(state.messages[1]).toMatchObject({ role: 'assistant', text: '', status: 'streaming' });
  });

  it('processes a full successful turn', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [
      { type: 'session_start', session_id: 'sess-1' },
      { type: 'reasoning', text: 'Let me ' },
      { type: 'reasoning', text: 'check.' },
      { type: 'tool_start', id: 't1', name: 'search_library', input: {} },
      { type: 'tool_end', id: 't1', name: 'search_library', status: 'success' },
      { type: 'token', text: 'Masz ' },
      { type: 'token', text: '12 ' },
      { type: 'token', text: 'książek.' },
      { type: 'session_finish', session_id: 'sess-1', text: 'Masz 12 książek.', ok: true },
    ]);

    expect(state.sessionId).toBe('sess-1');
    const assistant = state.messages[1];
    expect(assistant.reasoning).toBe('Let me check.');
    expect(assistant.tools).toEqual([{ id: 't1', name: 'search_library', status: 'success' }]);
    expect(assistant.text).toBe('Masz 12 książek.');
    expect(assistant.status).toBe('done');
    expect(assistant.error).toBeUndefined();
  });

  it('keeps streamed tokens when session_finish text is empty', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [
      { type: 'token', text: 'partial answer' },
      { type: 'session_finish', text: '', ok: true },
    ]);
    expect(state.messages[1].text).toBe('partial answer');
    expect(state.messages[1].status).toBe('done');
  });

  it('marks a tool as error on a failed tool_end', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [
      { type: 'tool_start', id: 't9', name: 'reading_stats', input: {} },
      { type: 'tool_end', id: 't9', name: 'reading_stats', status: 'error' },
    ]);
    expect(state.messages[1].tools).toEqual([{ id: 't9', name: 'reading_stats', status: 'error' }]);
  });

  it('processes an error turn', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [
      { type: 'error', message: 'RuntimeError: boom' },
      { type: 'session_finish', text: '', ok: false },
    ]);
    const assistant = state.messages[1];
    expect(assistant.status).toBe('error');
    expect(assistant.error).toBe('RuntimeError: boom');
  });

  it('session_finish with ok=false marks the message as error even without an error event', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [{ type: 'session_finish', text: '', ok: false }]);
    expect(state.messages[1].status).toBe('error');
  });

  it('reset clears messages and session id', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [{ type: 'session_start', session_id: 's' }]);
    state = chatReducer(state, { type: 'reset' });
    expect(state).toEqual(initialChatState);
  });
});
