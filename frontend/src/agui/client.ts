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
  /** Fired at TOOL_CALL_START, before args finish streaming, so the UI shows the pill early. */
  onToolCallStart?: (call: { id: string; name: string }) => void;
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

/** One raw tool call collected from a turn (args still a JSON string). */
interface RawToolCall {
  id: string;
  name: string;
  argsRaw: string;
}

/** One model turn: stream events, returning the text and EVERY tool call it made. */
interface TurnOutcome {
  runId: string;
  text: string;
  /** All tool calls the model emitted this turn, in order (may be more than one). */
  toolCalls: RawToolCall[];
  error?: string;
}

/**
 * A tool result's final answer, or null. A tool (ask_librarian) may short-circuit
 * the run by returning `{ final_answer: true, answer: string }`: the answer is shown
 * to the user as the reply without another model turn.
 */
function finalAnswerOf(result: unknown): string | null {
  if (
    result &&
    typeof result === 'object' &&
    (result as { final_answer?: unknown }).final_answer === true
  ) {
    const answer = (result as { answer?: unknown }).answer;
    return typeof answer === 'string' ? answer : '';
  }
  return null;
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

  const outcome: TurnOutcome = { runId, text: '', toolCalls: [] };
  let currentTool: RawToolCall | null = null;

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
        // Surface the action pill the moment the call begins (item 9), not after the
        // stream closes — the UI shows "doing X" while the args still stream in.
        callbacks?.onToolCallStart?.({ id: event.toolCallId, name: event.toolCallName });
        break;
      case 'TOOL_CALL_ARGS':
        if (currentTool && currentTool.id === event.toolCallId) {
          currentTool.argsRaw += event.delta;
        }
        break;
      case 'TOOL_CALL_END':
        // Collect EVERY tool call of the turn. The model may emit more than one
        // (e.g. navigate + set); appending them all means none is silently dropped.
        outcome.toolCalls.push({
          id: event.toolCallId,
          name: event.toolCallName,
          // Prefer the full args carried on END; fall back to accumulated deltas.
          argsRaw: event.args || currentTool?.argsRaw || '',
        });
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

    if (outcome.toolCalls.length === 0) {
      // The model answered with text and asked for no tool: the run is done.
      finalText = outcome.text;
      if (outcome.text) {
        messages.push({ role: 'assistant', content: outcome.text });
      }
      callbacks?.onRunFinish?.();
      return { messages, finalText, toolCalls: executed };
    }

    // The model wants one OR MORE tools. Record ONE assistant turn carrying the
    // text and ALL of this turn's tool calls, so the toolUse/toolResult pairing the
    // backend (Bedrock) requires stays intact — a missing result for any emitted
    // call makes the next request a ValidationException.
    const calls: AgUiToolCall[] = outcome.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: parseArgs(tc.argsRaw),
    }));
    messages.push({
      role: 'assistant',
      content: outcome.text,
      toolCalls: calls,
    });

    // Execute every call in order and append a tool result for each, in the same
    // order, so each toolUse has its matching toolResult.
    let allOk = true;
    for (const call of calls) {
      executed.push(call);
      callbacks?.onToolCall?.(call);
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
      if (!ok) {
        allOk = false;
      }
      callbacks?.onToolResult?.(call.id, result, ok);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
      });

      // A tool may carry its own final answer (ask_librarian): the librarian already
      // produced the user-facing reply, so end the loop and show it directly, with NO
      // extra model turn. The assistant/tool messages are already recorded above, so
      // the thread stays consistent for the next command.
      const final = finalAnswerOf(result);
      if (ok && final !== null) {
        callbacks?.onTextDelta?.(final);
        messages.push({ role: 'assistant', content: final });
        finalText = final;
        callbacks?.onRunFinish?.();
        return { messages, finalText, toolCalls: executed };
      }
    }

    // Item 7: the model may write its confirmation sentence in the SAME turn as its
    // last action. If every tool succeeded AND the model produced text, the request
    // is complete — no extra round-trip just for the sentence. On any tool error we
    // loop so the model can read the error and correct itself.
    if (allOk && outcome.text.trim()) {
      finalText = outcome.text;
      callbacks?.onRunFinish?.();
      return { messages, finalText, toolCalls: executed };
    }
  }

  // Hit the safety cap with the model still calling tools.
  return {
    messages,
    finalText,
    toolCalls: executed,
    error: `agent did not finish within ${maxTurns} turns`,
  };
}
