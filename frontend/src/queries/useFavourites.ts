import { useMemo } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { Book } from '../types';
import { useBooksQuery } from './useBooksQuery';

export interface UseFavouritesResult extends Omit<UseQueryResult<Book[], Error>, 'data'> {
  /** The favourite books (books with `favourite === true`), derived from the cached list. */
  favourites: Book[];
}

/**
 * Favourites are NOT a separate endpoint: they are the books flagged favourite, derived
 * from the one cached book list. So the Favourites tab shares the Library's cache and
 * needs no extra request — switching Library ↔ Favourites is always instant.
 */
export function useFavourites(): UseFavouritesResult {
  const query = useBooksQuery();
  const favourites = useMemo(
    () => (query.data ?? []).filter((b) => b.favourite),
    [query.data],
  );
  return { ...query, favourites };
}
