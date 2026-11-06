import { afterEach, describe, expect, it, vi } from 'vitest';

import { UI_BUS_ACK_EVENT, UI_BUS_EVENT, type UiBusDetail } from './bus';
import { createTools, toolSchemas } from './tools';
import type { Book } from '../types';

const BOOKS: Book[] = [
  {
    id: 7,
    title: 'Początek',
    authors: ['Wasilij Mahanienko'],
    series: 'Droga Szamana',
    shelves: ['Fantasy'],
    tags: ['LitRPG'],
    stars: 5,
    display_score: 4.8,
    insights: null,
  } as unknown as Book,
  {
    id: 9,
    title: 'Diuna',
    authors: ['Frank Herbert'],
    series: null,
    shelves: ['SF'],
    tags: [],
    stars: 5,
    display_score: 5.0,
    insights: null,
  } as unknown as Book,
];

function tool(name: string) {
  const t = createTools({ getBooks: () => BOOKS }).find((x) => x.name === name);
  if (!t) {
    throw new Error(`no tool ${name}`);
  }
  return t;
}

/** Auto-ack every bus event so dispatchAndWait resolves immediately. */
function withAutoAck<T>(fn: () => Promise<T>): Promise<T> {
  const onBus = (e: Event) => {
    const detail = (e as CustomEvent).detail as UiBusDetail;
    window.dispatchEvent(
      new CustomEvent(UI_BUS_ACK_EVENT, { detail: { action: detail.action, ok: true } }),
    );
  };
  window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
  return fn().finally(() => window.removeEventListener(UI_BUS_EVENT, onBus as EventListener));
}

afterEach(() => vi.restoreAllMocks());

describe('toolSchemas', () => {
  it('exposes exactly the 13 browser tools with JSON-schema parameters', () => {
    const schemas = toolSchemas(createTools({ getBooks: () => [] }));
    const names = schemas.map((s) => s.name);
    expect(names).toEqual([
      'navigate',
      'set_search',
      'set_star_filter',
      'filter_library',
      'clear_filter',
      'open_book',
      'open_add_book',
      'open_settings',
      'set_setting',
      'toggle_theme',
      'ranking_search',
      'get_ui_state',
      'find_books',
    ]);
    for (const s of schemas) {
      expect(s.parameters).toMatchObject({ type: 'object' });
    }
  });
});

describe('find_books', () => {
  it('matches across title/author/series and returns ids + titles', () => {
    const out = tool('find_books').execute({ query: 'Droga Szamana' }) as {
      count: number;
      books: { id: number; title: string }[];
    };
    expect(out.count).toBe(1);
    expect(out.books[0]).toMatchObject({ id: 7, title: 'Początek' });
  });

  it('requires every term to match (AND)', () => {
    const out = tool('find_books').execute({ query: 'Frank Diuna' }) as { count: number };
    expect(out.count).toBe(1);
    const miss = tool('find_books').execute({ query: 'Frank Szamana' }) as { count: number };
    expect(miss.count).toBe(0);
  });
});

describe('get_ui_state', () => {
  it('reads the exposed snapshot', () => {
    window.__shelfieUiState = { tab: 'library', visibleBookIds: [7] };
    const out = tool('get_ui_state').execute({}) as { state: { tab: string } };
    expect(out.state.tab).toBe('library');
    delete window.__shelfieUiState;
  });
});

describe('set_star_filter', () => {
  it('coerces to a whole star 1..5 and dispatches it', async () => {
    const seen: UiBusDetail[] = [];
    const onBus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    await withAutoAck(() => Promise.resolve(tool('set_star_filter').execute({ stars: 4.9 })));
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(seen[0]).toEqual({ action: 'set_star_filter', stars: 5 });
  });

  it('passes null through to clear the filter', async () => {
    const out = (await withAutoAck(() =>
      Promise.resolve(tool('set_star_filter').execute({ stars: null })),
    )) as { stars: unknown };
    expect(out.stars).toBeNull();
  });
});

describe('filter_library', () => {
  it('dispatches only the set facets', async () => {
    const seen: UiBusDetail[] = [];
    const onBus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    await withAutoAck(() =>
      Promise.resolve(tool('filter_library').execute({ series: 'Droga Szamana', query: '' })),
    );
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(seen[0]).toEqual({ action: 'filter_library', series: 'Droga Szamana' });
  });
});

describe('open_add_book', () => {
  it('defaults to search mode and carries the query', async () => {
    const seen: UiBusDetail[] = [];
    const onBus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    await withAutoAck(() =>
      Promise.resolve(tool('open_add_book').execute({ mode: 'search', query: 'Diuna' })),
    );
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(seen[0]).toEqual({
      action: 'open_add_book',
      mode: 'search',
      query: 'Diuna',
      prefill: undefined,
    });
  });
});

describe('navigate', () => {
  it('rejects an unknown tab without dispatching', async () => {
    const seen: UiBusDetail[] = [];
    const onBus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(UI_BUS_EVENT, onBus as EventListener);
    const out = (await Promise.resolve(tool('navigate').execute({ tab: 'nope' }))) as {
      ok: boolean;
    };
    window.removeEventListener(UI_BUS_EVENT, onBus as EventListener);
    expect(out.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
