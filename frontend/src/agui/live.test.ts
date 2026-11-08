/**
 * LIVE integration test — drives the full browser-side agent loop against the
 * REAL `/api/agui/run` endpoint and REAL Bedrock, through the UNIVERSAL
 * registry-driven tools (describe_ui / get_state / set / invoke / navigate /
 * find_books). It is skipped unless `AGUI_LIVE` is set and `AGUI_BASE` points at
 * a running dev server (e.g. `http://127.0.0.1:8099`), so it never runs in
 * `just check`.
 *
 * It registers a small set of anchors mirroring the real app, then verifies the
 * acceptance prompts drive those anchors — proving the model reads the live
 * schema and acts through the generic verbs with no per-action tool.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAgent, type AgUiMessage } from './client';
import { createTools } from './tools';
import {
  _resetRegistry,
  registerAnchor,
  setActiveTab,
  setStaticTabs,
} from '../agent-ui';
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

/** A record of what the model drove, captured by the anchors. */
interface Driven {
  tab: string;
  librarySearch: string;
  filter: Record<string, unknown> | null;
  addBook: { action?: string; args?: Record<string, unknown> } | null;
  starFilter: string;
}

/** Register anchors mirroring the app's library tab, capturing what the agent does. */
function installAnchors(driven: Driven): void {
  setStaticTabs([
    { id: 'library', label: 'Library' },
    { id: 'stats', label: 'Statistics' },
    { id: 'ranking', label: 'Ranking' },
  ]);
  setActiveTab('library');
  registerAnchor({
    id: 'nav.tab',
    kind: 'tab',
    label: 'Navigation tab',
    actions: ['navigate'],
    getState: () => driven.tab,
    invoke: (_a, args) => {
      driven.tab = String(args?.tab);
      setActiveTab(driven.tab);
    },
  });
  registerAnchor({
    id: 'library.search',
    kind: 'search',
    label: 'Library search',
    tab: 'library',
    getState: () => driven.librarySearch,
    set: (v) => {
      driven.librarySearch = String(v ?? '');
    },
  });
  registerAnchor({
    id: 'library.starFilter',
    kind: 'select',
    label: 'Star rating filter',
    tab: 'library',
    getState: () => driven.starFilter,
    options: () => [
      { value: '', label: 'Any rating' },
      { value: '1', label: '1 star' },
      { value: '2', label: '2 stars' },
      { value: '3', label: '3 stars' },
      { value: '4', label: '4 stars' },
      { value: '5', label: '5 stars' },
    ],
    set: (v) => {
      driven.starFilter = String(v ?? '');
    },
  });
  registerAnchor({
    id: 'library.filter',
    kind: 'button',
    label: 'Assistant library filter',
    tab: 'library',
    actions: ['apply', 'clear'],
    getState: () => driven.filter,
    invoke: (action, args) => {
      driven.filter = action === 'clear' ? null : (args ?? {});
    },
  });
  registerAnchor({
    id: 'library.addBook',
    kind: 'button',
    label: 'Add a book',
    tab: 'library',
    actions: ['search', 'manual'],
    invoke: (action, args) => {
      driven.addBook = { action, args };
    },
  });
}

async function drive(prompt: string) {
  const driven: Driven = {
    tab: 'library',
    librarySearch: '',
    filter: null,
    addBook: null,
    starFilter: '',
  };
  installAnchors(driven);
  const toolSeq: { name: string; args: Record<string, unknown> }[] = [];
  const messages: AgUiMessage[] = [{ role: 'user', content: prompt }];
  const result = await runAgent({
    threadId: `live-${Date.now()}`,
    messages,
    tools: createTools({ getBooks: () => BOOKS }),
    endpoint: `${BASE}/api/agui/run`,
    fetchImpl: fetch,
    maxTurns: 10,
    callbacks: { onToolCall: (c) => toolSeq.push({ name: c.name, args: c.args }) },
  });
  return { result, driven, toolSeq };
}

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

describe.runIf(LIVE)('AG-UI live (real Bedrock, universal tools)', () => {
  it('pokaż książki z serii Droga Szamana -> find_books then invoke library.filter(series)', async () => {
    const { result, toolSeq, driven } = await drive('pokaż książki z serii Droga Szamana');
    // eslint-disable-next-line no-console
    console.log('[series]', JSON.stringify({ tools: toolSeq, driven, text: result.finalText }, null, 2));
    const names = toolSeq.map((t) => t.name);
    expect(names).toContain('find_books');
    expect(String((driven.filter?.series ?? '') as string)).toMatch(/Droga Szamana/i);
  }, 60000);

  it('chcę dodać książkę Diuna -> invoke library.addBook(search, "Diuna")', async () => {
    const { result, toolSeq, driven } = await drive('chcę dodać książkę Diuna');
    // eslint-disable-next-line no-console
    console.log('[add]', JSON.stringify({ tools: toolSeq, driven, text: result.finalText }, null, 2));
    expect(driven.addBook).toBeTruthy();
    expect(driven.addBook?.action ?? 'search').toBe('search');
    expect(String(driven.addBook?.args?.query ?? '')).toMatch(/Diuna/i);
  }, 60000);

  it('pokaż tylko 5 gwiazdek -> set library.starFilter 5', async () => {
    const { result, toolSeq, driven } = await drive('pokaż tylko 5 gwiazdek');
    // eslint-disable-next-line no-console
    console.log('[stars]', JSON.stringify({ tools: toolSeq, driven, text: result.finalText }, null, 2));
    expect(driven.starFilter).toBe('5');
  }, 60000);

  it('przejdź do rankingu -> navigate(ranking)', async () => {
    const { result, toolSeq, driven } = await drive('przejdź do rankingu');
    // eslint-disable-next-line no-console
    console.log('[nav]', JSON.stringify({ tools: toolSeq, driven, text: result.finalText }, null, 2));
    expect(driven.tab).toBe('ranking');
  }, 60000);
});
