import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetRegistry,
  anchorIds,
  describeUi,
  getAnchorState,
  invokeAnchor,
  LIST_ITEM_CAP,
  navigate,
  registerAnchor,
  setActiveTab,
  setAnchor,
  setStaticTabs,
} from './index';

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

describe('registerAnchor / unregister', () => {
  it('adds an anchor and removes it on unregister', () => {
    const off = registerAnchor({ id: 'a.b', kind: 'search', label: 'x' });
    expect(anchorIds()).toEqual(['a.b']);
    off();
    expect(anchorIds()).toEqual([]);
  });

  it('a remount replacing the id is not removed by the stale unregister', () => {
    const off1 = registerAnchor({ id: 'a.b', kind: 'search', label: 'first' });
    registerAnchor({ id: 'a.b', kind: 'search', label: 'second' });
    off1(); // the first registration's cleanup must NOT delete the live second one
    expect(anchorIds()).toEqual(['a.b']);
  });
});

describe('describeUi', () => {
  it('lists static tabs even when unmounted, and groups anchors by tab', () => {
    setStaticTabs([
      { id: 'library', label: 'Library' },
      { id: 'stats', label: 'Statistics' },
    ]);
    setActiveTab('library');
    registerAnchor({
      id: 'library.search',
      kind: 'search',
      label: 'Search',
      tab: 'library',
      getState: () => 'q',
      set: () => {},
    });

    const schema = describeUi();
    expect(schema.activeTab).toBe('library');
    expect(schema.tabs.map((t) => t.id)).toEqual(['library', 'stats']);
    const lib = schema.tabs.find((t) => t.id === 'library')!;
    expect(lib.active).toBe(true);
    expect(lib.mounted).toBe(true);
    expect(lib.anchors[0]).toMatchObject({ id: 'library.search', value: 'q', settable: true });
    const stats = schema.tabs.find((t) => t.id === 'stats')!;
    expect(stats.mounted).toBe(false);
    expect(stats.anchors).toEqual([]);
  });

  it('bounds a list anchor to LIST_ITEM_CAP items', () => {
    const many = Array.from({ length: LIST_ITEM_CAP + 20 }, (_, i) => ({ id: i, title: `#${i}` }));
    registerAnchor({ id: 'lib.books', kind: 'list', label: 'Books', tab: 'library', items: () => many });
    setStaticTabs([{ id: 'library', label: 'Library' }]);
    const lib = describeUi().tabs.find((t) => t.id === 'library')!;
    expect(lib.anchors[0].items).toHaveLength(LIST_ITEM_CAP);
  });

  it('places anchors without a tab in global', () => {
    registerAnchor({ id: 'theme.toggle', kind: 'select', label: 'Theme', getState: () => 'dark' });
    expect(describeUi().global.map((a) => a.id)).toEqual(['theme.toggle']);
  });
});

describe('setAnchor validation', () => {
  it('rejects a value outside a select anchor options with the valid list', async () => {
    registerAnchor({
      id: 's.period',
      kind: 'select',
      label: 'P',
      options: () => [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      set: () => {},
    });
    const bad = await setAnchor('s.period', 'c');
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['a', 'b']);
    const ok = await setAnchor('s.period', 'b');
    expect(ok.ok).toBe(true);
  });

  it('refuses to set a non-value kind', async () => {
    registerAnchor({ id: 'b.btn', kind: 'button', label: 'B', invoke: () => {} });
    const res = await setAnchor('b.btn', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot be set/);
  });

  it('validates every member of a multi-select array', async () => {
    registerAnchor({
      id: 'm.sel',
      kind: 'multi-select',
      label: 'M',
      options: () => [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
      ],
      set: () => {},
    });
    expect((await setAnchor('m.sel', ['x', 'y'])).ok).toBe(true);
    expect((await setAnchor('m.sel', ['x', 'z'])).ok).toBe(false);
  });
});

describe('invokeAnchor / navigate', () => {
  it('invoke rejects an action not in the anchor action list', async () => {
    registerAnchor({ id: 'd.dlg', kind: 'dialog', label: 'D', actions: ['open', 'close'], invoke: () => {} });
    const bad = await invokeAnchor('d.dlg', 'explode');
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['open', 'close']);
    expect((await invokeAnchor('d.dlg', 'open')).ok).toBe(true);
  });

  it('navigate rejects an unknown tab', async () => {
    setStaticTabs([{ id: 'library', label: 'Library' }]);
    registerAnchor({ id: 'nav.tab', kind: 'tab', label: 'Nav', actions: ['navigate'], invoke: () => {} });
    const bad = await navigate('nope');
    expect(bad.ok).toBe(false);
    expect(bad.valid).toEqual(['library']);
    expect((await navigate('library')).ok).toBe(true);
  });

  it('getAnchorState reports an unknown id with the valid id list', () => {
    registerAnchor({ id: 'a.b', kind: 'search', label: 'x', getState: () => '1' });
    const miss = getAnchorState('zzz');
    expect(miss.ok).toBe(false);
    expect(miss.valid).toContain('a.b');
  });
});
