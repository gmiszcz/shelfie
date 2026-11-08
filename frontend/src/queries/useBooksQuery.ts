import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { api } from '../services/api';
import type { Book } from '../types';
import { queryKeys } from './keys';
import { useQueryUserId } from './useQueryUser';

/**
 * The library book list, cached per user. This is the single source of truth for every
 * view that reads books (Library, Favourites, Ranking, Stats table derive from it or a
 * sibling query). Fresh for the client default (5 min), so switching tabs reuses it with
 * no refetch; stale → background refetch while the cached list keeps showing.
 */
export function useBooksQuery(): UseQueryResult<Book[], Error> {
  const userId = useQueryUserId();
  return useQuery({
    queryKey: queryKeys.books(userId),
    queryFn: () => api.listBooks(),
  });
}
