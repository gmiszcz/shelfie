import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgent, type AgUiMessage } from './client';
import { createTools } from './tools';
import { _resetRegistry, registerAnchor, setStaticTabs } from '../agent-ui';
import type { Book } from '../types';

/** Build an SSE Response body from a list of AG-UI event objects. */
function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * A fake fetch that returns a scripted turn per call. Records the request body
 * (parsed) so a test can assert what was sent to the backend each turn.
 */
function scriptedFetch(turns: object[][]) {
  const calls: { body: Record<string, unknown>; init?: RequestInit }[] = [];
  let i = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')), init });
    const events = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return sseResponse(events);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BOOKS: Book[] = [
  {
    id: 7,
    title: 'Początek',
    authors: ['Wasilij Mahanienko'],
    series: 'Droga Szamana',
    stars: 5,
    display_score: 4.8,
  } as unknown as Book,
  {
    id: 8,
    title: 'Świat Kart',
    authors: ['Wasilij Mahanienko'],
    series: 'Droga Szamana',
    stars: 4,
    display_score: 4.1,
  } as unknown as Book,
  {
    id: 9,
    title: 'Diuna',
    authors: ['Frank Herbert'],
    series: null,
    stars: 5,
    display_score: 5.0,
  } as unknown as Book,
];

function tools() {
  return createTools({ getBooks: () => BOOKS });
}

beforeEach(() => _resetRegistry());
afterEach(() => {
  vi.restoreAllMocks();
  _resetRegistry();
});

describe('runAgent — single text turn', () => {
  it('returns the model answer when no tool is called', async () => {
    const { impl, calls } = scriptedFetch([
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Masz ' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '3 książki.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
    ]);

    const deltas: string[] = [];
    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'ile mam książek?' }],
      tools: tools(),
      fetchImpl: impl,
      callbacks: { onTextDelta: (d) => deltas.push(d) },
    });

    expect(result.finalText).toBe('Masz 3 książki.');
    expect(result.toolCalls).toEqual([]);
    expect(deltas.join('')).toBe('Masz 3 książki.');
    expect(calls).toHaveLength(1);
    // Auth contract: session cookie + CSRF client header (else the backend 403s).
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect((calls[0].init?.headers as Record<string, string>)['X-Shelfie-Client']).toBe('web');
    // The generic tool schemas are sent to the backend.
    const sentTools = calls[0].body.tools as { name: string }[];
    expect(sentTools.map((t) => t.name)).toContain('find_books');
    expect(sentTools.map((t) => t.name)).toContain('describe_ui');
    expect(sentTools.map((t) => t.name)).toContain('invoke');
  });
});

describe('runAgent — tool loop', () => {
  it('executes find_books then invoke(library.filter), then answers', async () => {
    // A library filter anchor the model will drive.
    let appliedSeries: string | undefined;
    registerAnchor({
      id: 'library.filter',
      kind: 'button',
      label: 'Assistant filter',
      tab: 'library',
      actions: ['apply', 'clear'],
      invoke: (_action, args) => {
        appliedSeries = args?.series as string | undefined;
      },
    });

    const { impl, calls } = scriptedFetch([
      // Turn 1: the model calls find_books.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'find_books' },
        {
          type: 'TOOL_CALL_END',
          toolCallId: 'c1',
          toolCallName: 'find_books',
          args: JSON.stringify({ query: 'Droga Szamana' }),
        },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
      // Turn 2: the model invokes the library filter with the resolved series.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
        { type: 'TOOL_CALL_START', toolCallId: 'c2', toolCallName: 'invoke' },
        {
          type: 'TOOL_CALL_END',
          toolCallId: 'c2',
          toolCallName: 'invoke',
          args: JSON.stringify({
            id: 'library.filter',
            action: 'apply',
            args: { series: 'Droga Szamana' },
          }),
        },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
      ],
      // Turn 3: the model answers in text.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Pokazuję serię Droga Szamana.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r2' },
      ],
    ]);

    const actions: string[] = [];
    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'pokaż książki z serii Droga Szamana' }],
      tools: tools(),
      fetchImpl: impl,
      callbacks: { onToolCall: (c) => actions.push(c.name) },
    });

    // Three POSTs: find_books turn, invoke turn, final answer turn.
    expect(calls).toHaveLength(3);
    expect(actions).toEqual(['find_books', 'invoke']);
    expect(result.finalText).toBe('Pokazuję serię Droga Szamana.');
    // The invoke drove the real anchor.
    expect(appliedSeries).toBe('Droga Szamana');

    // The second request carried the tool result of find_books back to the model.
    const secondMessages = calls[1].body.messages as AgUiMessage[];
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
    const payload = JSON.parse(String(toolMsg?.content));
    expect(payload.count).toBe(2); // two Droga Szamana books in BOOKS
    expect(payload.books.map((b: { id: number }) => b.id).sort()).toEqual([7, 8]);
  });

  it('sends the live UI schema as state each turn', async () => {
    setStaticTabs([{ id: 'library', label: 'Library' }]);
    registerAnchor({
      id: 'library.search',
      kind: 'search',
      label: 'Library search',
      tab: 'library',
      getState: () => 'dune',
      set: () => {},
    });
    const { impl, calls } = scriptedFetch([
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'ok' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
    ]);
    await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'x' }],
      tools: tools(),
      fetchImpl: impl,
    });
    const state = calls[0].body.state as { tabs: { id: string; anchors: { id: string }[] }[] };
    const library = state.tabs.find((t) => t.id === 'library')!;
    expect(library.anchors.map((a) => a.id)).toContain('library.search');
  });

  it('executes EVERY tool call in a turn that emits more than one (bug 2, item 6)', async () => {
    const navigated: string[] = [];
    const searched: unknown[] = [];
    registerAnchor({
      id: 'nav.tab',
      kind: 'tab',
      label: 'Navigation',
      actions: ['navigate'],
      invoke: (_a, args) => {
        navigated.push(String(args?.tab));
      },
    });
    registerAnchor({
      id: 'library.search',
      kind: 'search',
      label: 'Library search',
      tab: 'library',
      getState: () => '',
      set: (v) => {
        searched.push(v);
      },
    });

    const { impl } = scriptedFetch([
      // One turn with TWO tool calls (navigate + set), no text.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'navigate' },
        { type: 'TOOL_CALL_END', toolCallId: 'c1', toolCallName: 'navigate', args: JSON.stringify({ tab: 'library' }) },
        { type: 'TOOL_CALL_START', toolCallId: 'c2', toolCallName: 'set' },
        { type: 'TOOL_CALL_END', toolCallId: 'c2', toolCallName: 'set', args: JSON.stringify({ id: 'library.search', value: 'dune' }) },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
      // Next turn: the model answers in text.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Gotowe.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
      ],
    ]);

    setStaticTabs([{ id: 'library', label: 'Library' }]);
    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'pokaż dune' }],
      tools: tools(),
      fetchImpl: impl,
    });

    // Both calls ran, in order — neither was silently dropped.
    expect(result.toolCalls.map((c) => c.name)).toEqual(['navigate', 'set']);
    expect(navigated).toEqual(['library']);
    expect(searched).toEqual(['dune']);
    expect(result.finalText).toBe('Gotowe.');
  });

  it('ends in the same turn when the model writes text alongside its action (item 7)', async () => {
    let appliedSeries: string | undefined;
    registerAnchor({
      id: 'library.filter',
      kind: 'button',
      label: 'Assistant filter',
      tab: 'library',
      actions: ['apply', 'clear'],
      invoke: (_a, args) => {
        appliedSeries = args?.series as string | undefined;
      },
    });

    const { impl, calls } = scriptedFetch([
      // A SINGLE turn: text confirmation AND the tool call together.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Pokazuję serię Dune.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'invoke' },
        { type: 'TOOL_CALL_END', toolCallId: 'c1', toolCallName: 'invoke', args: JSON.stringify({ id: 'library.filter', action: 'apply', args: { series: 'Dune' } }) },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
    ]);

    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'pokaż serię Dune' }],
      tools: tools(),
      fetchImpl: impl,
    });

    // The tool ran AND the loop finished without a second request for the sentence.
    expect(appliedSeries).toBe('Dune');
    expect(result.finalText).toBe('Pokazuję serię Dune.');
    expect(calls).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it('keeps looping after a tool ERROR even if the model also wrote text (item 7)', async () => {
    const { impl, calls } = scriptedFetch([
      // Turn 1: text + a call to a tool that fails (unknown anchor), so the loop must
      // continue so the model can correct itself.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Próbuję…' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'set' },
        { type: 'TOOL_CALL_END', toolCallId: 'c1', toolCallName: 'set', args: JSON.stringify({ id: 'nope.missing', value: 'x' }) },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r0' },
      ],
      // Turn 2: the model recovers and answers.
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Gotowe.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
      ],
    ]);

    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'x' }],
      tools: tools(),
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(2);
    expect(result.finalText).toBe('Gotowe.');
  });

  it('stops and reports an error on RUN_ERROR', async () => {
    const { impl } = scriptedFetch([
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r0' },
        { type: 'RUN_ERROR', threadId: 't', runId: 'r0', message: 'NoCredentialsError' },
      ],
    ]);
    const errors: string[] = [];
    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'x' }],
      tools: tools(),
      fetchImpl: impl,
      callbacks: { onError: (m) => errors.push(m) },
    });
    expect(result.error).toBe('NoCredentialsError');
    expect(errors).toEqual(['NoCredentialsError']);
  });

  it('stops at maxTurns when the model keeps calling tools', async () => {
    // Every turn calls describe_ui (a pure read), never answers.
    const loopTurn = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'rN' },
      { type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'describe_ui' },
      { type: 'TOOL_CALL_END', toolCallId: 'c', toolCallName: 'describe_ui', args: '{}' },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'rN' },
    ];
    const { impl, calls } = scriptedFetch([loopTurn]); // same script every call
    const result = await runAgent({
      threadId: 't',
      messages: [{ role: 'user', content: 'loop' }],
      tools: tools(),
      fetchImpl: impl,
      maxTurns: 3,
    });
    expect(calls).toHaveLength(3);
    expect(result.error).toMatch(/did not finish within 3 turns/);
  });
});
