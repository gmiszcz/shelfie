import { describe, expect, it } from 'vitest';

import type { ChatEvent } from '../types';
import { type ChatState, chatReducer, initialChatState } from './chatState';

function send(state: ChatState, text: string): ChatState {
  return chatReducer(state, { type: 'send', text, userId: 'u1', assistantId: 'a1' });
}

function feed(state: ChatState, events: ChatEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: 'event', event }), state);
}

describe('chatReducer — common', () => {
  it('send adds a user message and an empty streaming assistant message', () => {
    const state = send(initialChatState, 'Ile mam książek?');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      text: 'Ile mam książek?',
      status: 'done',
    });
    expect(state.messages[1]).toMatchObject({ role: 'assistant', text: '', status: 'streaming' });
  });

  it('reset clears messages and session id', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [{ type: 'session_start', session_id: 's' }]);
    state = chatReducer(state, { type: 'reset' });
    expect(state).toEqual(initialChatState);
  });
});

describe('chatReducer — library agent (backend wire events)', () => {
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

  it('session_finish ok=false marks error even without an error event', () => {
    let state = send(initialChatState, 'hi');
    state = feed(state, [{ type: 'session_finish', text: '', ok: false }]);
    expect(state.messages[1].status).toBe('error');
  });
});

describe('chatReducer — UI agent (browser-side actions)', () => {
  it('streams text deltas into the assistant message', () => {
    let state = send(initialChatState, 'pokaż serię');
    state = chatReducer(state, { type: 'text_delta', text: 'Pokazuję ' });
    state = chatReducer(state, { type: 'text_delta', text: '5 książek.' });
    state = chatReducer(state, { type: 'finish', ok: true });
    expect(state.messages[1].text).toBe('Pokazuję 5 książek.');
    expect(state.messages[1].status).toBe('done');
  });

  it('records a running action then marks it successful', () => {
    let state = send(initialChatState, 'pokaż serię');
    state = chatReducer(state, {
      type: 'action_start',
      id: 'u1',
      name: 'filter_library',
      label: 'Filter library: series Droga Szamana',
      args: { series: 'Droga Szamana' },
    });
    expect(state.messages[1].actions).toEqual([
      {
        id: 'u1',
        name: 'filter_library',
        label: 'Filter library: series Droga Szamana',
        args: { series: 'Droga Szamana' },
        status: 'running',
      },
    ]);
    state = chatReducer(state, { type: 'action_result', id: 'u1', ok: true });
    expect(state.messages[1].actions[0].status).toBe('success');
  });

  it('marks an action as error when the tool failed', () => {
    let state = send(initialChatState, 'otwórz książkę');
    state = chatReducer(state, {
      type: 'action_start',
      id: 'u2',
      name: 'open_book',
      label: 'Open book #999',
      args: { book_id: 999 },
    });
    state = chatReducer(state, { type: 'action_result', id: 'u2', ok: false });
    expect(state.messages[1].actions[0].status).toBe('error');
  });

  it('keeps data-tool chips empty for a UI-agent turn', () => {
    let state = send(initialChatState, 'przejdź do rankingu');
    state = chatReducer(state, {
      type: 'action_start',
      id: 'n1',
      name: 'navigate',
      label: 'Go to Ranking',
      args: { tab: 'ranking' },
    });
    state = chatReducer(state, { type: 'action_result', id: 'n1', ok: true });
    state = chatReducer(state, { type: 'finish', ok: true });
    expect(state.messages[1].tools).toEqual([]);
    expect(state.messages[1].actions).toHaveLength(1);
  });

  it('finish with ok=false records the error', () => {
    let state = send(initialChatState, 'hi');
    state = chatReducer(state, { type: 'finish', ok: false, error: 'did not finish' });
    expect(state.messages[1].status).toBe('error');
    expect(state.messages[1].error).toBe('did not finish');
  });
});
