import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAgentAnchor } from './useAgentAnchor';
import {
  _resetRegistry,
  describeUi,
  getAnchor,
  getAnchorState,
  setAnchor,
  setStaticTabs,
} from './index';

beforeEach(() => _resetRegistry());
afterEach(() => {
  cleanup();
  _resetRegistry();
});

/** A throwaway control that declares itself as an anchor — the agent never saw it before. */
function DummyControl() {
  const [value, setValue] = useState('before');
  useAgentAnchor({
    id: 'dummy.widget',
    kind: 'text-input',
    label: 'Dummy widget',
    tab: 'library',
    getState: () => value,
    set: (v) => setValue(String(v)),
  });
  return <span data-testid="dummy">{value}</span>;
}

describe('useAgentAnchor', () => {
  it('registers on mount and unregisters on unmount', () => {
    const { unmount } = render(<DummyControl />);
    expect(getAnchor('dummy.widget')).toBeTruthy();
    unmount();
    expect(getAnchor('dummy.widget')).toBeUndefined();
  });

  it('reads the control value live (no re-register needed)', async () => {
    render(<DummyControl />);
    expect(getAnchorState('dummy.widget').value).toBe('before');
    await act(async () => {
      await setAnchor('dummy.widget', 'after');
    });
    expect(getAnchorState('dummy.widget').value).toBe('after');
  });

  it('universality: describe_ui lists a brand-new control with NO agent-side code', async () => {
    setStaticTabs([{ id: 'library', label: 'Library' }]);
    render(<DummyControl />);

    // The schema — the only thing the agent reads — now contains the dummy control.
    const schema = describeUi();
    const anchor = schema.tabs
      .flatMap((t) => t.anchors)
      .find((a) => a.id === 'dummy.widget');
    expect(anchor).toMatchObject({
      id: 'dummy.widget',
      kind: 'text-input',
      label: 'Dummy widget',
      value: 'before',
      settable: true,
    });

    // And the generic set() drives it — the agent needed no new tool or case.
    await act(async () => {
      await setAnchor('dummy.widget', 'driven');
    });
    expect(getAnchorState('dummy.widget').value).toBe('driven');
  });
});
