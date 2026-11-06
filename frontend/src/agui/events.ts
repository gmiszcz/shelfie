/**
 * AG-UI event protocol for the browser-side agent (`POST /api/agui/run`).
 *
 * The backend runner (`app/agent/ui_agent.py`) streams these events over SSE.
 * One request = one model turn: `RUN_STARTED` first, then a text message
 * (START / CONTENT* / END) and/or one tool call (TOOL_CALL_START / ARGS* / END),
 * then `RUN_FINISHED` (or `RUN_ERROR`). A turn that emits a tool call ends right
 * after it; the client runs the tool and starts the next turn.
 */

export type AgUiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string }
  | { type: 'RUN_ERROR'; threadId: string; runId: string; message: string }
  | { type: 'TEXT_MESSAGE_START'; messageId: string }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string; toolCallName: string; args: string };

const KNOWN_TYPES = new Set<AgUiEvent['type']>([
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
]);

function isAgUiEvent(value: unknown): value is AgUiEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    KNOWN_TYPES.has((value as { type: AgUiEvent['type'] }).type)
  );
}

/**
 * A streaming SSE parser for the AG-UI event stream. Feed raw text chunks with
 * `push()`; it invokes `onEvent` once per complete `data:` frame (frames are
 * separated by a blank line). Non-JSON payloads and unknown event types are
 * ignored.
 */
export function createAgUiParser(onEvent: (event: AgUiEvent) => void) {
  let buffer = '';

  const flushFrame = (raw: string) => {
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean === '' || clean.startsWith(':')) {
        continue;
      }
      if (clean.startsWith('data:')) {
        let value = clean.slice(5);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join('\n');
    if (payload === '' || payload === '[DONE]') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (isAgUiEvent(parsed)) {
      onEvent(parsed);
    }
  };

  const drain = (final: boolean) => {
    while (true) {
      const lf = buffer.indexOf('\n\n');
      const crlf = buffer.indexOf('\r\n\r\n');
      if (lf === -1 && crlf === -1) {
        break;
      }
      let idx: number;
      let boundaryLen: number;
      if (crlf !== -1 && (lf === -1 || crlf < lf)) {
        idx = crlf;
        boundaryLen = 4;
      } else {
        idx = lf;
        boundaryLen = 2;
      }
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + boundaryLen);
      flushFrame(frame);
    }
    if (final && buffer.trim() !== '') {
      flushFrame(buffer);
      buffer = '';
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    end() {
      drain(true);
    },
  };
}

/** Read a fetch Response whose body is an AG-UI SSE stream, dispatching each event. */
export async function readAgUiStream(
  resp: Response,
  onEvent: (event: AgUiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!resp.ok) {
    let text = '';
    try {
      text = await resp.text();
    } catch {
      text = '';
    }
    throw new Error(text || `${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) {
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = createAgUiParser(onEvent);

  const onAbort = () => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
