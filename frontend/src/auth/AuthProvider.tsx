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
  /** Adopt a user returned by the setup flow (already logged in server-side). */
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUserState] = useState<AuthUser | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      // A 401 means the session is already gone — treat logout as done.
      if (!(err instanceof ApiError) || err.status !== 401) {
        throw err;
      }
    }
    setUserState(null);
    setStatus('anonymous');
  }, []);

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
    () => ({ status, user, login, logout, changePassword, setUser }),
    [status, user, login, logout, changePassword, setUser],
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
