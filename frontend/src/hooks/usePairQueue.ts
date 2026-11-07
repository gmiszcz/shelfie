import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../services/api';
import type { RatingPair, Winner } from '../types';

export interface PairQueueOptions {
  /** How many pairs to keep ready (the shown one included). */
  size?: number;
  sessionId: string;
  /** Called after a comparison is saved (e.g. to refresh scores in the table). */
  onCompared?: () => void;
  onError?: (message: string) => void;
}

const pairKey = (p: RatingPair): [number, number] => [p.left.id, p.right.id];

/**
 * Prefetch queue for the ranking page, so a choice never waits for the network.
 *
 * Keeps `size` pairs ready. `choose` shows the next queued pair at once, then saves the
 * comparison and refills the queue in the background (the refill skips pairs already queued).
 * `reset` (new category or focus) drops the queue and loads a fresh one; a generation counter
 * discards answers that belong to an older category/focus.
 */
export function usePairQueue({ size = 3, sessionId, onCompared, onError }: PairQueueOptions) {
  const [queue, setQueue] = useState<RatingPair[]>([]);
  const [loading, setLoading] = useState(true);
  const queueRef = useRef<RatingPair[]>([]);
  const filterRef = useRef<{ focus: number | null; group: string | null }>({ focus: null, group: null });
  const generation = useRef(0);
  const refilling = useRef(false);
  // Set when the server had fewer pairs than asked for; cleared by reset or a new comparison.
  const exhausted = useRef(false);
  const callbacks = useRef({ onCompared, onError });
  callbacks.current = { onCompared, onError };

  const publish = (next: RatingPair[]) => {
    queueRef.current = next;
    setQueue(next);
    // Warm the browser cache so the next pair's covers appear instantly too.
    for (const p of next.slice(1)) {
      for (const url of [p.left.cover_url, p.right.cover_url]) {
        if (url && typeof Image !== 'undefined') {
          new Image().src = url;
        }
      }
    }
  };

  const refill = useCallback(async () => {
    if (refilling.current || exhausted.current) {
      return;
    }
    const missing = size - queueRef.current.length;
    if (missing <= 0) {
      return;
    }
    refilling.current = true;
    const gen = generation.current;
    try {
      const fresh = await api.nextPairs(missing, {
        ...filterRef.current,
        skip: queueRef.current.map(pairKey),
      });
      if (gen !== generation.current) {
        return;
      }
      const have = new Set(queueRef.current.map((p) => pairKey(p).sort().join('-')));
      const add = fresh.filter((p) => !have.has(pairKey(p).sort().join('-')));
      exhausted.current = fresh.length < missing;
      publish([...queueRef.current, ...add].slice(0, size));
    } catch (err) {
      exhausted.current = true; // do not hammer the server on errors; next choice/reset retries
      callbacks.current.onError?.(err instanceof Error ? err.message : 'Could not load pairs');
    } finally {
      refilling.current = false;
      if (gen === generation.current) {
        setLoading(false);
      }
    }
  }, [size]);

  const reset = useCallback(
    async (focus: number | null, group: string | null) => {
      generation.current += 1;
      refilling.current = false;
      exhausted.current = false;
      filterRef.current = { focus, group };
      publish([]);
      setLoading(true);
      await refill();
    },
    [refill],
  );

  const choose = useCallback(
    (winner: Winner) => {
      const [current, ...rest] = queueRef.current;
      if (!current) {
        return;
      }
      // Show the next pair immediately; persistence and refill happen in the background.
      publish(rest);
      void api
        .compare(current.left.id, current.right.id, winner, sessionId)
        .then(() => callbacks.current.onCompared?.())
        .catch((err: unknown) =>
          callbacks.current.onError?.(
            err instanceof Error ? err.message : 'Could not record the comparison',
          ),
        )
        .finally(() => {
          exhausted.current = false;
          void refill();
        });
    },
    [refill, sessionId],
  );

  // Top up whenever the queue runs low and no refill is in flight.
  useEffect(() => {
    if (!loading && queue.length < size) {
      void refill();
    }
  }, [loading, queue.length, refill, size]);

  return { current: queue[0] ?? null, queued: queue.length, loading, reset, choose };
}
