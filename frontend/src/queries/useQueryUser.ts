import { useOptionalAuthUser } from '../auth';

/**
 * Fallback id used only when there is no AuthProvider above (unit tests that render a page
 * with just a QueryClient and a mocked `api`). In the running app the provider is always
 * present, so the real logged-in id is used and this fallback is never reached.
 */
const TEST_FALLBACK_USER_ID = 1;

/**
 * The current user's id for query keys. Returns the logged-in id, or the test fallback when
 * no AuthProvider is mounted. Queries pass this into the key factory; the real app gates on
 * the authenticated user via AuthGate, so queries only fire once someone is logged in.
 */
export function useQueryUserId(): number {
  const user = useOptionalAuthUser();
  return user?.id ?? TEST_FALLBACK_USER_ID;
}
