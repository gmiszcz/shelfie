import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from '../components/testHelpers';
import { api } from '../services/api';
import type { RatingPair } from '../types';
import { usePairQueue } from './usePairQueue';

const pair = (a: number, b: number): RatingPair => ({
  left: makeBook({ id: a, title: `B${a}` }),
  right: makeBook({ id: b, title: `B${b}` }),
});

afterEach(() => vi.restoreAllMocks());

describe('usePairQueue', () => {
  it('shows the next pair immediately and saves + refills in the background', async () => {
    const nextPairs = vi
      .spyOn(api, 'nextPairs')
      .mockResolvedValueOnce([pair(1, 2), pair(3, 4), pair(5, 6)])
      .mockResolvedValue([pair(7, 8)]);
    let resolveCompare: () => void = () => {};
    const compare = vi.spyOn(api, 'compare').mockImplementation(
      () => new Promise((r) => (resolveCompare = () => r(pair(1, 2)))),
    );
    const onCompared = vi.fn();
    const { result } = renderHook(() => usePairQueue({ size: 3, sessionId: 's', onCompared }));

    await act(async () => {
      await result.current.reset(null, 'Fantasy');
    });
    expect(result.current.current?.left.id).toBe(1);

    act(() => result.current.choose('left'));
    // The next queued pair is shown before the comparison request has even finished.
    expect(result.current.current?.left.id).toBe(3);
    expect(compare).toHaveBeenCalledWith(1, 2, 'left', 's');

    await act(async () => {
      resolveCompare();
    });
    await waitFor(() => expect(onCompared).toHaveBeenCalled());
    // The refill asked only for the missing slot and skipped the pairs still queued.
    await waitFor(() => expect(result.current.queued).toBe(3));
    const lastCall = nextPairs.mock.calls.at(-1)!;
    expect(lastCall[1]?.skip).toEqual([
      [3, 4],
      [5, 6],
    ]);
  });

  it('stops refilling when the server has no more pairs', async () => {
    const nextPairs = vi.spyOn(api, 'nextPairs').mockResolvedValue([pair(1, 2)]);
    const { result } = renderHook(() => usePairQueue({ size: 3, sessionId: 's' }));
    await act(async () => {
      await result.current.reset(null, null);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.queued).toBe(1);
    expect(nextPairs).toHaveBeenCalledTimes(1);
  });
});
