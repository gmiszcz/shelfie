/**
 * The AG-UI part of Shelfie: talk to the assistant and answer its browser tool calls.
 *
 * One user message can take several AG-UI runs:
 *   1. Run with the message, the browser tool definitions and the screen context.
 *   2. The agent may call its own data tools on the server (they stream back as a
 *      call + TOOL_CALL_RESULT). If it calls browser tools, the run ends with their
 *      ids in `pendingToolCallIds`. Run each one here and add a `tool` message.
 *   3. Run again with the results. Repeat until the agent answers in text.
 *
 * The server keeps the conversation per `threadId`; a new HttpAgent is a new chat.
 */
import { HttpAgent } from '@ag-ui/client';

import { describeScreen, isBrowserTool, runTool, TOOL_DEFINITIONS } from './tools';

export const AGENT_URL = '/api/agui';

/** The server does not limit tool rounds, so the client must. */
const MAX_ROUNDS = 10;

/** What the chat shows while a message is answered. */
export interface ChatEvents {
  onText: (delta: string) => void;
  onReasoning: (delta: string) => void;
  /** A tool call started. `browser` = runs here; otherwise a server data tool. */
  onToolCall: (toolCallId: string, name: string, browser: boolean) => void;
  /** Its arguments are known (shown in the action label). */
  onToolArgs: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult: (toolCallId: string, ok: boolean) => void;
  onError: (message: string) => void;
}

export function newAgent(): HttpAgent {
  return new HttpAgent({
    url: AGENT_URL,
    threadId: crypto.randomUUID(),
    // Same CSRF contract as services/api.ts; the session cookie goes with same-origin fetch.
    headers: { 'X-Shelfie-Client': 'web' },
  });
}

/** Resolve after the browser has painted the next frame (React effects have run). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Answer one user message. Resolves with the final answer text ('' on error). */
export async function ask(agent: HttpAgent, message: string, chat: ChatEvents): Promise<string> {
  agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: message });
  let answer = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let pending: string[] = [];
    let failed = false;
    const names: Record<string, string> = {};
    const argsBuf: Record<string, string> = {};

    try {
      await agent.runAgent(
        { tools: TOOL_DEFINITIONS, context: describeScreen() },
        {
          onTextMessageContentEvent: ({ event }) => {
            answer += event.delta;
            chat.onText(event.delta);
          },
          onReasoningMessageContentEvent: ({ event }) => chat.onReasoning(event.delta),
          onToolCallStartEvent: ({ event }) => {
            names[event.toolCallId] = event.toolCallName;
            argsBuf[event.toolCallId] = '';
            chat.onToolCall(event.toolCallId, event.toolCallName, isBrowserTool(event.toolCallName));
          },
          onToolCallArgsEvent: ({ event }) => {
            argsBuf[event.toolCallId] = (argsBuf[event.toolCallId] ?? '') + event.delta;
          },
          onToolCallEndEvent: ({ event }) => {
            const name = names[event.toolCallId] ?? '';
            chat.onToolArgs(event.toolCallId, name, parseArgs(argsBuf[event.toolCallId] ?? ''));
          },
          // A server data tool finished (browser tools have no result event).
          onToolCallResultEvent: ({ event }) => chat.onToolResult(event.toolCallId, true),
          onRunFinishedEvent: (params) => {
            if (params.outcome === 'success') pending = params.pendingToolCallIds;
          },
          onRunErrorEvent: ({ event }) => {
            failed = true;
            chat.onError(`${event.message}${event.code ? ` (${event.code})` : ''}`);
          },
        },
      );
    } catch (err) {
      if (!failed) chat.onError(err instanceof Error ? err.message : String(err));
      return '';
    }
    if (failed) return '';
    if (pending.length === 0) return answer;

    // Run every browser tool the agent called and add the results for the next run.
    for (const id of pending) {
      const call = agent.messages
        .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
        .find((c) => c.id === id);
      const result = call
        ? await runTool(call.function.name, call.function.arguments)
        : { content: '', error: 'Unknown tool call.' };
      agent.addMessage({
        id: crypto.randomUUID(),
        role: 'tool',
        toolCallId: id,
        content: result.content,
        error: result.error,
      });
      chat.onToolResult(id, !result.error);
    }
    // Let React commit what the tools changed (a tab switch mounts new controls) before
    // the next run reads the screen. Otherwise the context still shows the old tab and
    // the agent repeats a call that already worked.
    await nextPaint();
  }
  chat.onError(`Stopped after ${MAX_ROUNDS} tool rounds. Start a new chat.`);
  return '';
}

/** Forget a conversation on the server ("new chat"). Best-effort. */
export async function forgetThread(threadId: string): Promise<void> {
  await fetch(`${AGENT_URL}/threads/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-Shelfie-Client': 'web' },
  });
}
