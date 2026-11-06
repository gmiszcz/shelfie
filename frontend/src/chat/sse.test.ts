import { describe, expect, it } from 'vitest';

import type { ChatEvent } from '../types';
import { createSseParser } from './sse';

function collect(chunks: string[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  for (const c of chunks) {
    parser.push(c);
  }
  parser.end();
  return events;
}

describe('createSseParser', () => {
  it('parses one frame delivered whole', () => {
    const events = collect(['data: {"type":"token","text":"hi"}\n\n']);
    expect(events).toEqual([{ type: 'token', text: 'hi' }]);
  });

  it('reassembles a frame split across chunks mid-payload', () => {
    const events = collect([
      'data: {"type":"to',
      'ken","text":"he',
      'llo"}\n\n',
    ]);
    expect(events).toEqual([{ type: 'token', text: 'hello' }]);
  });

  it('handles several frames in a single chunk', () => {
    const events = collect([
      'data: {"type":"session_start","session_id":"s1"}\n\n' +
        'data: {"type":"token","text":"a"}\n\n' +
        'data: {"type":"token","text":"b"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'session_start', session_id: 's1' },
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ]);
  });

  it('handles CRLF frame boundaries', () => {
    const events = collect([
      'data: {"type":"token","text":"x"}\r\n\r\n' +
        'data: {"type":"token","text":"y"}\r\n\r\n',
    ]);
    expect(events).toEqual([
      { type: 'token', text: 'x' },
      { type: 'token', text: 'y' },
    ]);
  });

  it('ignores comments and [DONE] sentinels', () => {
    const events = collect([
      ': keep-alive\n\n',
      'data: [DONE]\n\n',
      'data: {"type":"token","text":"z"}\n\n',
      ': another comment\n\n',
    ]);
    expect(events).toEqual([{ type: 'token', text: 'z' }]);
  });

  it('ignores non-JSON data payloads', () => {
    const events = collect(['data: not json at all\n\n', 'data: {"type":"token","text":"ok"}\n\n']);
    expect(events).toEqual([{ type: 'token', text: 'ok' }]);
  });

  it('joins multi-line data into one payload', () => {
    const events = collect(['data: {"type":"token",\ndata: "text":"multi"}\n\n']);
    expect(events).toEqual([{ type: 'token', text: 'multi' }]);
  });

  it('flushes a trailing frame with no final blank line on end()', () => {
    const events = collect(['data: {"type":"session_finish","text":"done","ok":true}']);
    expect(events).toEqual([{ type: 'session_finish', text: 'done', ok: true }]);
  });

  it('parses a full realistic turn', () => {
    const events = collect([
      'data: {"type":"session_start","session_id":"abc"}\n\n',
      ': ping\n\n',
      'data: {"type":"reasoning","text":"Let me think"}\n\n',
      'data: {"type":"tool_start","id":"t1","name":"search_library","input":{}}\n\n',
      'data: {"type":"tool_end","id":"t1","name":"search_library","status":"success"}\n\n',
      'data: {"type":"token","text":"Zna"}\n\n',
      'data: {"type":"token","text":"lazłem"}\n\n',
      'data: {"type":"session_finish","session_id":"abc","text":"Znalazłem 3.","ok":true}\n\n',
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'session_start',
      'reasoning',
      'tool_start',
      'tool_end',
      'token',
      'token',
      'session_finish',
    ]);
    expect(events[events.length - 1]).toEqual({
      type: 'session_finish',
      session_id: 'abc',
      text: 'Znalazłem 3.',
      ok: true,
    });
  });
});
