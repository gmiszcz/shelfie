import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A QueryClient tuned for tests: retries off and no stale window, so a mutation's
 * invalidate refetches synchronously and assertions see the settled state quickly.
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/**
 * Wrap children (or a renderHook body) in a fresh QueryClientProvider. Use as the
 * `wrapper` option of `renderHook`, or render `<QueryWrapper>…</QueryWrapper>` in a
 * component test. Each call gets its own client so tests do not share cache.
 */
export function QueryWrapper({
  children,
  client,
}: {
  children: ReactNode;
  client?: QueryClient;
}) {
  const qc = client ?? makeTestQueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
