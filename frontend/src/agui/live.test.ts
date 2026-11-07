/**
 * LIVE integration test — drives the full browser-side agent loop against the
 * REAL `/api/agui/run` endpoint and REAL Bedrock. It is skipped unless the env
 * var `AGUI_LIVE` is set and `AGUI_BASE` points at a running dev server (e.g.
 * `http://127.0.0.1:8099`), so it never runs in `just check`.
 *
 * It verifies the four acceptance prompts and prints the AG-UI event sequence
 * (tool calls) each one produced. A real `shelfie:ui` listener acks every action
 * so the loop behaves exactly as in the browser.
 */

import { describe, expect, it } from 'vitest';

import { UI_BUS_ACK_EVENT, UI_BUS_EVENT, type UiBusDetail } from './bus';
import { runAgent, type AgUiMessage } from './client';
import { createTools } from './tools';
import type { Book } from '../types';

const LIVE = Boolean(process.env.AGUI_LIVE);
const BASE = process.env.AGUI_BASE ?? 'http://127.0.0.1:8099';

// A small fixture mirroring the real library so find_books can resolve names.
const BOOKS: Book[] = [
  { id: 101, title: 'Początek', authors: ['Wasilij Mahanienko'], series: 'Droga Szamana', stars: 5, display_score: 4.9 } as unknown as Book,
  { id: 102, title: 'Świat Kart', authors: ['Wasilij Mahanienko'], series: 'Droga Szamana', stars: 5, display_score: 4.7 } as unknown as Book,
  { id: 103, title: 'Step', authors: ['Wasilij Mahanienko'], series: 'Droga Szamana', stars: 4, display_score: 4.2 } as unknown as Book,
  { id: 201, title: 'Hobbit', authors: ['J.R.R. Tolkien'], series: null, stars: 5, display_score: 5.0 } as unknown as Book,
];

function installBusListener(captured: UiBusDetail[]): () => void {
  const onBus = (e: Event) => {
    const detail = (e as CustomEvent).detail as UiBusDetail;
    captured.push(detail);
    window.dispatchEvent(
      new CustomEvent(UI_BUS_ACK_EVENT, { detail: { action: detail.action, ok: true, info: 'live-test' } }),
    );
  };
  window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
  return () => window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
}

async function drive(prompt: string) {
  const busEvents: UiBusDetail[] = [];
  const toolSeq: { name: string; args: Record<string, unknown> }[] = [];
  const remove = installBusListener(busEvents);
  const messages: AgUiMessage[] = [{ role: 'user', content: prompt }];
  const result = await runAgent({
    threadId: `live-${Date.now()}`,
    messages,
    tools: createTools({ getBooks: () => BOOKS }),
    endpoint: `${BASE}/api/agui/run`,
    fetchImpl: fetch,
    maxTurns: 8,
    callbacks: { onToolCall: (c) => toolSeq.push({ name: c.name, args: c.args }) },
  });
  remove();
  return { result, busEvents, toolSeq };
}

describe.runIf(LIVE)('AG-UI live (real Bedrock)', () => {
  it('pokaż książki z serii Droga Szamana -> find_books then filter_library(series)', async () => {
    const { result, toolSeq, busEvents } = await drive('pokaż książki z serii Droga Szamana');
    // eslint-disable-next-line no-console
    console.log('[series]', JSON.stringify({ tools: toolSeq, bus: busEvents, text: result.finalText }, null, 2));
    const names = toolSeq.map((t) => t.name);
    expect(names).toContain('find_books');
    expect(names).toContain('filter_library');
    const filter = toolSeq.find((t) => t.name === 'filter_library');
    expect(String(filter?.args.series ?? '')).toMatch(/Droga Szamana/i);
  }, 60000);

  it('chcę dodać książkę Diuna -> open_add_book(search, "Diuna")', async () => {
    const { result, toolSeq } = await drive('chcę dodać książkę Diuna');
    // eslint-disable-next-line no-console
    console.log('[add]', JSON.stringify({ tools: toolSeq, text: result.finalText }, null, 2));
    const add = toolSeq.find((t) => t.name === 'open_add_book');
    expect(add).toBeTruthy();
    expect(add?.args.mode ?? 'search').toBe('search');
    expect(String(add?.args.query ?? '')).toMatch(/Diuna/i);
  }, 60000);

  it('pokaż tylko 5 gwiazdek -> set_star_filter(5)', async () => {
    const { result, toolSeq } = await drive('pokaż tylko 5 gwiazdek');
    // eslint-disable-next-line no-console
    console.log('[stars]', JSON.stringify({ tools: toolSeq, text: result.finalText }, null, 2));
    const star = toolSeq.find((t) => t.name === 'set_star_filter');
    expect(star).toBeTruthy();
    expect(star?.args.stars).toBe(5);
  }, 60000);

  it('przejdź do rankingu -> navigate(ranking)', async () => {
    const { result, toolSeq } = await drive('przejdź do rankingu');
    // eslint-disable-next-line no-console
    console.log('[nav]', JSON.stringify({ tools: toolSeq, text: result.finalText }, null, 2));
    const nav = toolSeq.find((t) => t.name === 'navigate');
    expect(nav).toBeTruthy();
    expect(nav?.args.tab).toBe('ranking');
  }, 60000);
});
