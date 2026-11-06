import type { ChatEvent } from '../types';

/** A streaming SSE parser. Feed it raw text chunks with push(); it invokes
 *  onEvent once per complete `data:` frame. Frames are separated by a blank
 *  line (`\n\n` or `\r\n\r\n`); a frame's `data:` lines are joined with `\n`.
 *  `:` comment lines and non-JSON payloads (e.g. `[DONE]`) are ignored. */
export function createSseParser(onEvent: (event: ChatEvent) => void) {
  let buffer = '';

  const flushFrame = (raw: string) => {
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      // Strip a trailing CR so lone-\n and CRLF framing behave identically.
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean === '' || clean.startsWith(':')) {
        continue; // blank or comment line
      }
      if (clean.startsWith('data:')) {
        // Per the SSE spec a single leading space after the colon is stripped.
        let value = clean.slice(5);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        dataLines.push(value);
      }
      // Other fields (event:, id:, retry:) are not part of this protocol.
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
      return; // non-JSON payload: ignore
    }
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      onEvent(parsed as ChatEvent);
    }
  };

  const drain = (final: boolean) => {
    // Frames are delimited by a blank line in either newline style.
    // Normalize by splitting on the two boundary forms.
    let idx: number;
    // Find the earliest boundary of either kind, repeatedly.
    while (true) {
      const lf = buffer.indexOf('\n\n');
      const crlf = buffer.indexOf('\r\n\r\n');
      if (lf === -1 && crlf === -1) {
        break;
      }
      let boundaryLen = 2;
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

/** Read a fetch Response whose body is an SSE stream, dispatching each event.
 *  Throws (with the body text) when the response is not ok. */
export async function readChatStream(
  resp: Response,
  onEvent: (event: ChatEvent) => void,
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
  const parser = createSseParser(onEvent);

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
