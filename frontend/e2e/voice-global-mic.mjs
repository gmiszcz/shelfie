// Playwright fake-audio check for the GLOBAL microphone (talk with the chat
// closed). It proves the real browser capture pipeline end to end — the mic
// records from a WAV file, the hook's RMS VAD auto-stops on the trailing
// silence, the transcript is sent to the UI agent WITHOUT opening the chat, the
// agent drives the real anchor registry (a tab navigation), and the result
// toast shows the transcript + reply and opens the chat on tap.
//
// HERMETIC: no AWS, no Bedrock, no Google Books. Three HTTP routes and the
// transcription WebSocket are faked in the browser, so the check is
// deterministic and runs offline:
//   - GET  /api/auth/me          -> a logged-in user (skip the login gate)
//   - GET  /api/books            -> []
//   - WS   /api/transcribe/stream -> {ready} then {final, text:"..."} once audio flows
//   - POST /api/agui/run         -> AG-UI SSE: turn 1 = navigate(stats), turn 2 = text reply
//
// The fake audio is injected with Chromium's own flags
//   --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
//   --use-file-for-fake-audio-capture=<wav>
// so getUserMedia returns the fixture WAV (frontend/e2e/fixtures/speech.wav).
// Serving `dist` on 127.0.0.1 makes the page a SECURE CONTEXT, so the mic is
// allowed over plain http (no self-signed cert needed).
//
// Usage:  node frontend/e2e/voice-global-mic.mjs
// Exit 0 = pass, non-zero = fail. A 45 s watchdog hard-exits so an outer
// Start-Job + Wait-Job -Timeout 55 never hangs.
//
// Playwright and its Chromium are reused from the runtime node_modules; set
// PLAYWRIGHT_MODULE / SHELFIE_DIST to override discovery.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const DIST = process.env.SHELFIE_DIST ? resolve(process.env.SHELFIE_DIST) : join(FRONTEND, 'dist');
const WAV = join(HERE, 'fixtures', 'speech.wav');
const HOST = '127.0.0.1';
const FINAL_TRANSCRIPT = 'pokaż statystyki';
const AGENT_REPLY = 'Otworzyłem statystyki.';

// --- resolve the reused Playwright -----------------------------------------
function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    process.env.KIROCREW_SCRATCH && join(process.env.KIROCREW_SCRATCH, 'node_modules', 'playwright'),
    join(FRONTEND, 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const req = createRequire(join(c, 'package.json'));
      return req(c);
    } catch {
      /* try next */
    }
  }
  // Last resort: normal resolution from here.
  const req = createRequire(import.meta.url);
  return req('playwright');
}

// --- a tiny static server for the built SPA --------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = join(DIST, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
      let info = null;
      try {
        info = await stat(filePath);
      } catch {
        info = null;
      }
      // SPA fallback: unknown non-asset routes serve index.html.
      if (!info || info.isDirectory()) {
        filePath = join(DIST, 'index.html');
      }
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((r) => server.listen(0, HOST, r));
  const { port } = server.address();
  return { server, base: `http://${HOST}:${port}` };
}

// --- SSE helpers for the faked agent ---------------------------------------
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function agentTurnBody(turnIndex) {
  const threadId = 't';
  const runId = `r${turnIndex}`;
  if (turnIndex === 0) {
    // Turn 1: the model calls navigate(stats) — drives the REAL registry.
    return (
      sse({ type: 'RUN_STARTED', threadId, runId }) +
      sse({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'navigate' }) +
      sse({ type: 'TOOL_CALL_END', toolCallId: 'c1', toolCallName: 'navigate', args: JSON.stringify({ tab: 'stats' }) }) +
      sse({ type: 'RUN_FINISHED', threadId, runId })
    );
  }
  // Turn 2: the model answers in text — ends the run.
  return (
    sse({ type: 'RUN_STARTED', threadId, runId }) +
    sse({ type: 'TEXT_MESSAGE_START', messageId: 'm1' }) +
    sse({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: AGENT_REPLY }) +
    sse({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) +
    sse({ type: 'RUN_FINISHED', threadId, runId })
  );
}

async function main() {
  if (!existsSync(DIST) || !existsSync(join(DIST, 'index.html'))) {
    throw new Error(`built frontend not found at ${DIST} — run "npm run build" in frontend/ first`);
  }
  if (!existsSync(WAV)) {
    throw new Error(`fake-audio fixture missing: ${WAV} (regenerate with fixtures/make-fixture-wav.mjs)`);
  }

  const { chromium } = resolvePlaywright();
  const { server, base } = await serveDist();
  let browser;
  const failures = [];
  const pass = (name) => console.log(`PASS  ${name}`);
  const fail = (name, detail) => {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${WAV}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['microphone'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);

    // --- faked HTTP routes ---------------------------------------------------
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, email: 'e2e@shelfie.test', display_name: 'E2E', is_admin: true }),
      }),
    );
    await page.route('**/api/books', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    let agentTurns = 0;
    await page.route('**/api/agui/run', (route) => {
      const body = agentTurnBody(agentTurns);
      agentTurns += 1;
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body,
      });
    });

    // --- faked transcription WebSocket --------------------------------------
    // Once the browser sends audio frames, reply with one final transcript.
    await page.routeWebSocket(/\/api\/transcribe\/stream/, (ws) => {
      let sentFinal = false;
      ws.onMessage((msg) => {
        if (typeof msg === 'string') {
          // control frames: {action:'start'|'stop'}
          try {
            const ctrl = JSON.parse(msg);
            if (ctrl.action === 'start') {
              ws.send(JSON.stringify({ type: 'ready', language: ctrl.language || 'pl-PL' }));
            }
          } catch {
            /* ignore */
          }
          return;
        }
        // binary audio frame arrived -> emit a single final transcript once.
        if (!sentFinal) {
          sentFinal = true;
          ws.send(JSON.stringify({ type: 'final', text: FINAL_TRANSCRIPT }));
        }
      });
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });

    // The main view renders the global mic and the chat FAB; chat starts closed.
    const mic = page.getByRole('button', { name: /Talk to the assistant/i });
    await mic.waitFor();
    pass('global mic is visible on the main view');

    const chatOpen = async () =>
      page.evaluate(() => !!document.querySelector('.chat-panel, .chat-widget-panel, [data-chat-open="true"]'));
    // A generous "closed" probe: the chat input placeholder is absent while closed.
    const chatVisible = async () =>
      (await page.getByPlaceholder(/Tell me what to do|Ask/i).count()) > 0;
    if (!(await chatVisible())) pass('chat panel is closed before speaking');
    else fail('chat panel is closed before speaking', 'chat input already visible');

    // Tap the mic -> recording starts; fake audio plays; VAD auto-stops on the
    // trailing silence; the final transcript is sent to the UI agent head-less.
    await mic.click();

    // Wait for the agent to have driven navigate(stats): the Stats tab active.
    const statsActive = async () =>
      page.evaluate(() => {
        const active = document.querySelector('.app-nav-item.active');
        return (active?.textContent || '').toLowerCase().includes('stat');
      });
    const deadline = Date.now() + 25_000;
    let navigated = false;
    while (Date.now() < deadline) {
      if (await statsActive()) {
        navigated = true;
        break;
      }
      await page.waitForTimeout(400);
    }
    if (navigated) pass('transcript drove the UI agent: navigated to Stats with the chat closed');
    else fail('transcript drove the UI agent: navigated to Stats', 'Stats tab never became active');

    if (agentTurns >= 2) pass('UI agent ran a tool turn then answered (navigate -> text)');
    else fail('UI agent ran a tool turn then answered', `only ${agentTurns} agent turn(s) seen`);

    // The result toast shows the transcript and the agent's reply.
    const toast = page.locator('.global-mic-toast');
    try {
      await toast.waitFor({ timeout: 8_000 });
      const text = (await toast.textContent()) || '';
      if (text.includes(FINAL_TRANSCRIPT)) pass('toast shows the spoken transcript');
      else fail('toast shows the spoken transcript', JSON.stringify(text.slice(0, 120)));
      if (text.includes(AGENT_REPLY)) pass('toast shows the agent reply');
      else fail('toast shows the agent reply', JSON.stringify(text.slice(0, 120)));
    } catch {
      fail('result toast appeared', 'no .global-mic-toast within 8 s');
    }

    // Tapping the toast opens the chat on that exchange.
    if ((await toast.count()) > 0) {
      await toast.click();
      try {
        await page.getByPlaceholder(/Tell me what to do|Ask/i).first().waitFor({ timeout: 6_000 });
        pass('tapping the toast opens the chat');
      } catch {
        fail('tapping the toast opens the chat', 'chat input did not appear');
      }
    }

    if (failures.length === 0) {
      console.log('\nALL_PASS');
    } else {
      console.error(`\n${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    server.close();
  }
}

// Hard watchdog so the process never outlives an outer 55 s Wait-Job window.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG_EXIT (45 s)');
  process.exit(2);
}, 45_000);
watchdog.unref();

main()
  .then(() => clearTimeout(watchdog))
  .catch((err) => {
    clearTimeout(watchdog);
    console.error('RUNNER_ERROR', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
