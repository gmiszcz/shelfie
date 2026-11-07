/**
 * The browser-side AG-UI agent run loop (the frontend-tools client).
 *
 * `runAgent()` drives the full loop the user's frustration was about:
 *
 *   1. POST the conversation + tool schemas + UI state to `/api/agui/run`.
 *   2. Stream AG-UI events; collect streamed text and at most one tool call.
 *   3. If the model answered with TEXT only -> done.
 *   4. If the model emitted a TOOL CALL -> execute it in the browser (dispatch
 *      the UI bus event / read state / search loaded books), append the tool's
 *      result as a `tool` message, and go back to step 1.
 *
 * The loop stops when the model produces no tool call, on `RUN_ERROR`, on abort,
 * or when it hits `maxTurns` (a safety cap). The transport (`fetchImpl`) is
 * injected so the whole loop is unit-testable against a fake `fetch`.
 */

import type { AgentTool } from './tools';
import { toolSchemas } from './tools';
import { describeUi } from '../agent-ui';
import { readAgUiStream, type AgUiEvent } from './events';

export type AgUiRole = 'user' | 'assistant' | 'tool';

export interface AgUiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgUiMessage {
  role: AgUiRole;
  content: string;
  toolCalls?: AgUiToolCall[];
  toolCallId?: string;
}

/** Callbacks the UI uses to render the run as it streams. */
export interface RunCallbacks {
  onRunStart?: (runId: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: AgUiToolCall) => void;
  onToolResult?: (callId: string, result: unknown, ok: boolean) => void;
  onError?: (message: string) => void;
  onRunFinish?: () => void;
}

export interface RunAgentOptions {
  threadId: string;
  messages: AgUiMessage[];
  tools: AgentTool[];
  signal?: AbortSignal;
  maxTurns?: number;
  callbacks?: RunCallbacks;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export interface RunAgentResult {
  /** The full message list including the assistant/tool turns produced here. */
  messages: AgUiMessage[];
  /** The assistant's final text answer (empty if the run errored before answering). */
  finalText: string;
  /** Tool calls executed across the whole run, in order. */
  toolCalls: AgUiToolCall[];
  error?: string;
}

/** One model turn: stream events, returning the text and an optional tool call. */
interface TurnOutcome {
  runId: string;
  text: string;
  toolCall: { id: string; name: string; argsRaw: string } | null;
  error?: string;
}

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function runTurn(
  runId: string,
  options: Required<Pick<RunAgentOptions, 'threadId' | 'endpoint'>> & RunAgentOptions,
): Promise<TurnOutcome> {
  const { threadId, messages, tools, signal, callbacks, endpoint } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body = JSON.stringify({
    threadId,
    runId,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? [],
      toolCallId: m.toolCallId ?? null,
    })),
    tools: toolSchemas(tools),
    state: describeUi(),
  });

  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    // Same auth contract as services/api.ts: session cookie + the CSRF client
    // header every state-changing /api request must carry.
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Shelfie-Client': 'web',
    },
    body,
    signal,
  });

  const outcome: TurnOutcome = { runId, text: '', toolCall: null };
  let currentTool: { id: string; name: string; argsRaw: string } | null = null;

  const onEvent = (event: AgUiEvent) => {
    switch (event.type) {
      case 'RUN_STARTED':
        callbacks?.onRunStart?.(event.runId || runId);
        break;
      case 'TEXT_MESSAGE_CONTENT':
        outcome.text += event.delta;
        callbacks?.onTextDelta?.(event.delta);
        break;
      case 'TOOL_CALL_START':
        currentTool = { id: event.toolCallId, name: event.toolCallName, argsRaw: '' };
        break;
      case 'TOOL_CALL_ARGS':
        if (currentTool && currentTool.id === event.toolCallId) {
          currentTool.argsRaw += event.delta;
        }
        break;
      case 'TOOL_CALL_END':
        outcome.toolCall = {
          id: event.toolCallId,
          name: event.toolCallName,
          // Prefer the full args carried on END; fall back to accumulated deltas.
          argsRaw: event.args || currentTool?.argsRaw || '',
        };
        currentTool = null;
        break;
      case 'RUN_ERROR':
        outcome.error = event.message;
        break;
      default:
        break;
    }
  };

  await readAgUiStream(resp, onEvent, signal);
  return outcome;
}

/**
 * Run the agent to completion (or to `maxTurns`). Executes any tool the model
 * calls in the browser and feeds the result back, until the model answers in
 * text. Pure orchestration — the transport and tools are injected.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const endpoint = options.endpoint ?? '/api/agui/run';
  const maxTurns = options.maxTurns ?? 8;
  const tools = options.tools;
  const callbacks = options.callbacks;
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const messages: AgUiMessage[] = [...options.messages];
  const executed: AgUiToolCall[] = [];
  let finalText = '';

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal?.aborted) {
      return { messages, finalText, toolCalls: executed, error: 'aborted' };
    }
    const runId = `${options.threadId}-${turn}-${Math.random().toString(36).slice(2, 8)}`;
    const outcome = await runTurn(runId, { ...options, messages, endpoint });

    if (outcome.error) {
      callbacks?.onError?.(outcome.error);
      return { messages, finalText, toolCalls: executed, error: outcome.error };
    }

    if (!outcome.toolCall) {
      // The model answered with text and asked for no tool: the run is done.
      finalText = outcome.text;
      if (outcome.text) {
        messages.push({ role: 'assistant', content: outcome.text });
      }
      callbacks?.onRunFinish?.();
      return { messages, finalText, toolCalls: executed };
    }

    // The model wants a tool. Record the assistant turn (text + the call).
    const call: AgUiToolCall = {
      id: outcome.toolCall.id,
      name: outcome.toolCall.name,
      args: parseArgs(outcome.toolCall.argsRaw),
    };
    messages.push({
      role: 'assistant',
      content: outcome.text,
      toolCalls: [call],
    });
    executed.push(call);
    callbacks?.onToolCall?.(call);

    // Execute the tool in the browser and append its result.
    let result: unknown;
    let ok = true;
    const tool = toolByName.get(call.name);
    if (!tool) {
      result = { ok: false, error: `unknown tool ${call.name}` };
      ok = false;
    } else {
      try {
        result = await tool.execute(call.args);
        ok =
          !(result && typeof result === 'object' && 'ok' in result) ||
          Boolean((result as { ok?: unknown }).ok);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        ok = false;
      }
    }
    callbacks?.onToolResult?.(call.id, result, ok);
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(result),
    });
  }

  // Hit the safety cap with the model still calling tools.
  return {
    messages,
    finalText,
    toolCalls: executed,
    error: `agent did not finish within ${maxTurns} turns`,
  };
}
