import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetRegistry,
  registerAnchor,
  setActiveTab,
  setStaticTabs,
  type UiSchema,
} from '../agent-ui';
import { describeScreen, isBrowserTool, runTool, TOOL_DEFINITIONS } from './tools';

/** Run a browser tool like the AG-UI loop does and parse its result. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await runTool(name, JSON.stringify(args));
  return {
    value: result.content ? (JSON.parse(result.content) as Record<string, unknown>) : null,
    error: result.error ? (JSON.parse(result.error) as Record<string, unknown>) : null,
  };
}

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

describe('TOOL_DEFINITIONS', () => {
  it('exposes exactly the 5 generic screen tools, without run functions', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'describe_ui',
      'get_state',
      'set',
      'invoke',
      'navigate',
    ]);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.parameters).toMatchObject({ type: 'object' });
      expect('run' in t).toBe(false);
    }
  });

  it('isBrowserTool tells screen tools from server data tools', () => {
    expect(isBrowserTool('navigate')).toBe(true);
    expect(isBrowserTool('search_library')).toBe(false);
  });
});

describe('runTool', () => {
  it('reports an unknown tool and bad JSON as errors, never throws', async () => {
    expect((await runTool('nope', '{}')).error).toMatch(/unknown tool/);
    expect((await runTool('navigate', '{oops')).error).toBeTruthy();
  });
});

describe('describe_ui / describeScreen', () => {
  it('builds the schema from the live registry and sends it as AG-UI context', async () => {
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

    const schema = (await call('describe_ui')).value as unknown as UiSchema;
    expect(schema.activeTab).toBe('library');
    const library = schema.tabs.find((t) => t.id === 'library')!;
    expect(library.anchors.find((a) => a.id === 'library.search')).toMatchObject({
      kind: 'search',
      value: 'dune',
      settable: true,
    });
    expect(schema.tabs.find((t) => t.id === 'stats')?.mounted).toBe(false);

    const [context] = describeScreen();
    expect(JSON.parse(context.value)).toEqual(schema);
  });
});

describe('get_state / set / invoke / navigate', () => {
  it('get_state reads an anchor; an unknown id lists the valid ones', async () => {
    registerAnchor({ id: 'library.search', kind: 'search', label: 's', getState: () => 'x' });
    expect((await call('get_state', { id: 'library.search' })).value).toMatchObject({ value: 'x' });
    const miss = await call('get_state', { id: 'nope' });
    expect(miss.error?.valid).toContain('library.search');
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
    expect((await call('set', { id: 'stats.period', value: 'last12Months' })).error).toBeNull();
    expect(value).toBe('last12Months');
    const bad = await call('set', { id: 'stats.period', value: 'nope' });
    expect(bad.error?.valid).toEqual(['thisYear', 'last12Months']);
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
    await call('invoke', { id: 'library.books', action: 'open', args: { id: 7 } });
    expect(calls[0]).toEqual({ action: 'open', args: { id: 7 } });
    const bad = await call('invoke', { id: 'library.books', action: 'delete' });
    expect(bad.error?.valid).toEqual(['open']);
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
    expect((await call('navigate', { tab: 'stats' })).error).toBeNull();
    expect(tab).toBe('stats');
    expect((await call('navigate', { tab: 'nope' })).error?.valid).toEqual(['library', 'stats']);
  });
});

describe('universality — a brand-new control needs no agent code', () => {
  it('describe_ui lists a freshly registered anchor and set() drives it', async () => {
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
    const schema = (await call('describe_ui')).value as unknown as UiSchema;
    const found = schema.tabs
      .flatMap((t) => t.anchors)
      .concat(schema.global)
      .find((a) => a.id === 'future.widget');
    expect(found).toMatchObject({ kind: 'text-input', value: 'before', settable: true });
    await call('set', { id: 'future.widget', value: 'after' });
    expect(dummy).toBe('after');
  });
});
