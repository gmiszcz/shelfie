import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { clearPersistedCache } from '../queries';
import { ApiError, api, onUnauthorized } from '../services/api';
import type { AuthUser } from './authTypes';

/** The phase the auth gate is in. */
type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Log in with e-mail + password. Throws ApiError (401 invalid, 429 throttled). */
  login: (email: string, password: string) => Promise<void>;
  /** Log out and drop back to the login screen. */
  logout: () => Promise<void>;
  /** Change the current password; the server revokes other sessions. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Create an account and log in. Throws ApiError (409 taken, 422 weak, 403 closed, 429). */
  register: (email: string, displayName: string, password: string) => Promise<void>;
  /** Change the current person's display name. */
  updateProfile: (displayName: string) => Promise<void>;
  /** Adopt a user returned by the setup flow (already logged in server-side). */
  setUser: (user: AuthUser) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The current user without throwing when there is no AuthProvider above. Query hooks use
 * this so a component can be unit-tested with just a QueryClient (no auth stack) — it then
 * reads the fallback test id. In the real app the provider is always present.
 */
export function useOptionalAuthUser(): AuthUser | null {
  return useContext(AuthContext)?.user ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUserState] = useState<AuthUser | null>(null);
  const mounted = useRef(true);
  const queryClient = useQueryClient();
  // The id the cache currently belongs to, so a switch to a DIFFERENT person wipes it.
  const cacheOwner = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Drop every cached query AND the persisted IndexedDB copy. Called on logout and when
   * the logged-in person changes, so one user's library is never shown to another even
   * for an instant (the query keys are already per-user; this is the belt-and-braces wipe
   * the spec requires).
   */
  const wipeCache = useCallback(async () => {
    queryClient.cancelQueries();
    queryClient.clear();
    await clearPersistedCache();
  }, [queryClient]);

  // Whenever the logged-in user changes to a different id (or to nobody), wipe the cache
  // so the previous person's persisted data can never render for the new one.
  useEffect(() => {
    const id = user?.id ?? null;
    if (cacheOwner.current !== null && cacheOwner.current !== id) {
      void wipeCache();
    }
    cacheOwner.current = id;
  }, [user?.id, wipeCache]);

  // Load "who am I" once at startup. A 401 is the normal "not logged in" answer
  // (the probe opts out of the global handler), so it resolves to anonymous.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (!cancelled) {
          setUserState(me);
          setStatus('authenticated');
        }
      } catch {
        if (!cancelled) {
          setUserState(null);
          setStatus('anonymous');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from a normal request (session expired) sends the app back to login.
  // The gate keeps the current route so the person returns to it after logging in.
  useEffect(() => {
    return onUnauthorized(() => {
      if (!mounted.current) return;
      setUserState(null);
      setStatus('anonymous');
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const me = await api.login(email, password);
    setUserState(me);
    setStatus('authenticated');
  }, []);

  const register = useCallback(
    async (email: string, displayName: string, password: string) => {
      const me = await api.register(email, displayName, password);
      setUserState(me);
      setStatus('authenticated');
    },
    [],
  );

  const updateProfile = useCallback(async (displayName: string) => {
    const me = await api.updateMe(displayName);
    setUserState(me);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      // A 401 means the session is already gone — treat logout as done.
      if (!(err instanceof ApiError) || err.status !== 401) {
        throw err;
      }
    }
    // Clear the (persisted) cache so the next person to log in on this device starts clean.
    await wipeCache();
    setUserState(null);
    setStatus('anonymous');
  }, [wipeCache]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.changePassword(currentPassword, newPassword);
    },
    [],
  );

  const setUser = useCallback((next: AuthUser) => {
    setUserState(next);
    setStatus('authenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, updateProfile, logout, changePassword, setUser }),
    [status, user, login, register, updateProfile, logout, changePassword, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
