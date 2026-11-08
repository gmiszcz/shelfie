import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_FX_EVENT, findAnchorElement, type AgentFxDetail } from './agentFx';
import { _resetRegistry, registerAnchor, setStaticTabs } from './index';
import { createTools } from '../agui/tools';

const seen: AgentFxDetail[] = [];
const onFx = (e: Event) => seen.push((e as CustomEvent<AgentFxDetail>).detail);

function tool(name: string) {
  const t = createTools({ getBooks: () => [] }).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(() => {
  _resetRegistry();
  seen.length = 0;
  window.addEventListener(AGENT_FX_EVENT, onFx);
});
afterEach(() => {
  window.removeEventListener(AGENT_FX_EVENT, onFx);
  _resetRegistry();
  document.body.innerHTML = '';
});

describe('agent fx', () => {
  it('fires only after a successful agent set / invoke / navigate', async () => {
    let value = 'thisYear';
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
    setStaticTabs([
      { id: 'library', label: 'Library' },
      { id: 'stats', label: 'Statistics' },
    ]);
    registerAnchor({
      id: 'nav.tab',
      kind: 'tab',
      label: 'Nav',
      actions: ['navigate'],
      getState: () => 'library',
      invoke: () => {},
    });

    await tool('set').execute({ id: 'stats.period', value: 'nope' });
    expect(seen).toHaveLength(0); // failed set: no effect

    await tool('set').execute({ id: 'stats.period', value: 'last12Months' });
    await tool('navigate').execute({ tab: 'stats' });
    await tool('invoke').execute({ id: 'nav.tab', action: 'navigate', args: { tab: 'library' } });

    expect(seen.map((d) => [d.kind, d.target])).toEqual([
      ['set', 'stats.period'],
      ['navigate', 'stats'],
      ['navigate', 'library'],
    ]);
    expect(seen.every((d) => d.label.length > 0)).toBe(true);
  });

  it('findAnchorElement falls back from exact id to the tab list to main', () => {
    document.body.innerHTML = `
      <main class="app-main">
        <div data-agent-anchor="library.search"></div>
        <div data-agent-anchor="library.books"></div>
      </main>`;
    expect(findAnchorElement('library.search')?.dataset.agentAnchor).toBe('library.search');
    expect(findAnchorElement('library.sort')?.dataset.agentAnchor).toBe('library.books');
    expect(findAnchorElement('settings.showAllDetails')?.className).toBe('app-main');
  });
});
