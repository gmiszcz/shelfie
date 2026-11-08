import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTools, toolSchemas } from './tools';
import {
  _resetRegistry,
  registerAnchor,
  setStaticTabs,
  setActiveTab,
  type UiSchema,
} from '../agent-ui';
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

beforeEach(() => {
  _resetRegistry();
});
afterEach(() => {
  _resetRegistry();
});

describe('toolSchemas', () => {
  it('exposes exactly the 8 generic browser tools with JSON-schema parameters', () => {
    const schemas = toolSchemas(createTools({ getBooks: () => [] }));
    const names = schemas.map((s) => s.name);
    expect(names).toEqual([
      'describe_ui',
      'get_state',
      'set',
      'invoke',
      'navigate',
      'find_books',
      'series_releases',
      'ask_librarian',
    ]);
    for (const s of schemas) {
      expect(s.parameters).toMatchObject({ type: 'object' });
    }
  });
});

describe('ask_librarian', () => {
  it('calls the injected librarian and carries its answer as the final answer', async () => {
    const calls: string[] = [];
    const t = createTools({
      getBooks: () => BOOKS,
      askLibrarian: async (q) => {
        calls.push(q);
        return 'Przeczytałeś 12 książek w 2026.';
      },
    }).find((x) => x.name === 'ask_librarian')!;

    const result = (await t.execute({ question: 'ile w tym roku?' })) as {
      ok: boolean;
      final_answer: boolean;
      answer: string;
    };

    expect(calls).toEqual(['ile w tym roku?']);
    expect(result.ok).toBe(true);
    expect(result.final_answer).toBe(true);
    expect(result.answer).toBe('Przeczytałeś 12 książek w 2026.');
  });

  it('fails gracefully when no librarian is wired', async () => {
    const t = tool('ask_librarian');
    const result = (await t.execute({ question: 'ile?' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/);
  });

  it('reports the error when the librarian call throws', async () => {
    const t = createTools({
      getBooks: () => BOOKS,
      askLibrarian: async () => {
        throw new Error('NoCredentialsError');
      },
    }).find((x) => x.name === 'ask_librarian')!;
    const result = (await t.execute({ question: 'ile?' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('NoCredentialsError');
  });
});

describe('describe_ui', () => {
  it('builds the schema from the live registry, grouped by tab', () => {
    setStaticTabs([
      { id: 'library', label: 'Library' },
      { id: 'stats', label: 'Statistics' },
    ]);
    setActiveTab('library');
    registerAnchor({
      id: 'library.search',
      kind: 'search',
      label: 'Library search',
      tab: 'library',
      getState: () => 'dune',
      set: () => {},
    });
    registerAnchor({
      id: 'theme.toggle',
      kind: 'select',
      label: 'Theme',
      getState: () => 'dark',
      options: () => [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
      set: () => {},
    });

    const out = tool('describe_ui').execute({}) as { ok: boolean; schema: UiSchema };
    expect(out.ok).toBe(true);
    expect(out.schema.activeTab).toBe('library');
    const library = out.schema.tabs.find((t) => t.id === 'library')!;
    expect(library.active).toBe(true);
    expect(library.mounted).toBe(true);
    const search = library.anchors.find((a) => a.id === 'library.search')!;
    expect(search).toMatchObject({ kind: 'search', value: 'dune', settable: true });
    // The unmounted stats tab is still listed (from the static nav).
    const stats = out.schema.tabs.find((t) => t.id === 'stats')!;
    expect(stats.mounted).toBe(false);
    // The global theme anchor carries its options.
    const theme = out.schema.global.find((a) => a.id === 'theme.toggle')!;
    expect(theme.options).toEqual([
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ]);
  });
});

describe('get_state / set / invoke / navigate', () => {
  it('get_state reads a registered anchor and errors on an unknown id', () => {
    registerAnchor({ id: 'library.search', kind: 'search', label: 's', getState: () => 'x' });
    expect(tool('get_state').execute({ id: 'library.search' })).toMatchObject({
      ok: true,
      value: 'x',
    });
    const miss = tool('get_state').execute({ id: 'nope' }) as { ok: boolean; valid: string[] };
    expect(miss.ok).toBe(false);
    expect(miss.valid).toContain('library.search');
  });

  it('set writes a value control and validates against options', async () => {
    let value = '';
    registerAnchor({
      id: 'stats.period',
      kind: 'select',
      label: 'Period',
      getState: () => value,
      options: () => [
        { value: 'thisYear', label: 'This year' },
        { value: 'last12Months', label: 'Last 12 months' },
      ],
      set: (v) => {
        value = String(v);
      },
    });
    const ok = (await tool('set').execute({ id: 'stats.period', value: 'last12Months' })) as {
      ok: boolean;
    };
    expect(ok.ok).toBe(true);
    expect(value).toBe('last12Months');

    const bad = (await tool('set').execute({ id: 'stats.period', value: 'nope' })) as {
      ok: boolean;
      valid: string[];
    };
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['thisYear', 'last12Months']);
  });

  it('invoke runs an action and reports valid actions on error', async () => {
    const calls: { action?: string; args?: unknown }[] = [];
    registerAnchor({
      id: 'library.books',
      kind: 'list',
      label: 'Books',
      actions: ['open'],
      items: () => [{ id: 7, title: 'Początek' }],
      invoke: (action, args) => {
        calls.push({ action, args });
      },
    });
    const ok = (await tool('invoke').execute({
      id: 'library.books',
      action: 'open',
      args: { id: 7 },
    })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(calls[0]).toEqual({ action: 'open', args: { id: 7 } });

    const bad = (await tool('invoke').execute({ id: 'library.books', action: 'delete' })) as {
      ok: boolean;
      valid: string[];
    };
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['open']);
  });

  it('navigate switches through the nav.tab anchor and rejects unknown tabs', async () => {
    setStaticTabs([
      { id: 'library', label: 'Library' },
      { id: 'stats', label: 'Statistics' },
    ]);
    let tab = 'library';
    registerAnchor({
      id: 'nav.tab',
      kind: 'tab',
      label: 'Nav',
      actions: ['navigate'],
      getState: () => tab,
      invoke: (_a, args) => {
        tab = String(args?.tab);
      },
    });
    const ok = (await tool('navigate').execute({ tab: 'stats' })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(tab).toBe('stats');

    const bad = (await tool('navigate').execute({ tab: 'nope' })) as {
      ok: boolean;
      valid: string[];
    };
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['library', 'stats']);
  });
});

describe('universality — a brand-new control needs no agent code', () => {
  it('describe_ui lists a freshly registered dummy anchor and set() drives it', async () => {
    // A component the agent has never heard of registers itself at runtime.
    let dummy = 'before';
    registerAnchor({
      id: 'future.widget',
      kind: 'text-input',
      label: 'A future control',
      tab: 'library',
      getState: () => dummy,
      set: (v) => {
        dummy = String(v);
      },
    });

    // The agent discovers it purely from describe_ui — no tool was added.
    const schema = (tool('describe_ui').execute({}) as { schema: UiSchema }).schema;
    const found = schema.tabs
      .flatMap((t) => t.anchors)
      .concat(schema.global)
      .find((a) => a.id === 'future.widget');
    expect(found).toMatchObject({
      id: 'future.widget',
      kind: 'text-input',
      label: 'A future control',
      value: 'before',
      settable: true,
    });

    // And the generic set() tool drives it with no change to the agent.
    const res = (await tool('set').execute({ id: 'future.widget', value: 'after' })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(dummy).toBe('after');
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
