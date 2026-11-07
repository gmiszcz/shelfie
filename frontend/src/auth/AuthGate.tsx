import { useEffect, useState, type ReactNode } from 'react';

import { useAuth } from './AuthProvider';
import { AuthSplash } from './AuthSplash';
import { api } from '../services/api';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { SetupPasswordPage } from './SetupPasswordPage';

/** Read the current path + query so we can detect the /setup link and the return route. */
function readLocation(): { path: string; token: string | null } {
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get('token');
  return { path, token };
}

/** Is this the setup screen? ( /setup, with or without a trailing slash ) */
function isSetupPath(path: string): boolean {
  return path === '/setup' || path === '/setup/';
}

/**
 * AuthGate — the top-level routing between the splash, the public pages
 * (login, /setup) and the authenticated app.
 *
 * - While "who am I" resolves: a neutral splash.
 * - /setup?token=...: the SetupPasswordPage, logged in or not (so a new person
 *   can set their password). On success it clears the path and the app opens.
 * - Logged out: the LoginPage. The route the person was on is remembered and
 *   restored after they log in.
 * - Logged in (and not on /setup): the app.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [loc, setLoc] = useState(readLocation);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registrationOpen, setRegistrationOpen] = useState(false);

  // Ask the server whether self-registration is on (public endpoint).
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.authConfig())
      .then((cfg) => {
        if (!cancelled) setRegistrationOpen(cfg.registration_enabled);
      })
      .catch(() => {
        if (!cancelled) setRegistrationOpen(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Track back/forward navigation so the gate stays in sync with the URL.
  useEffect(() => {
    const onPop = () => setLoc(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Remember where the person was headed when a 401 bounced them to login, so we
  // can restore it after they authenticate. /setup and the login screen itself
  // are never a return target.
  const onSetup = isSetupPath(loc.path);

  // Leave the setup screen and go to the app root once setup completes.
  function leaveSetup() {
    window.history.replaceState(null, '', '/');
    setLoc(readLocation());
  }

  // A bare /setup without a token is not a usable link: fall through to login.
  if (onSetup && loc.token) {
    // The setup page is public: it resolves its own token and logs the person in.
    return <SetupPasswordPage token={loc.token ?? ''} onDone={leaveSetup} />;
  }

  if (status === 'loading') {
    return <AuthSplash />;
  }

  if (status === 'anonymous') {
    if (mode === 'register' && registrationOpen) {
      return <RegisterPage onLogin={() => setMode('login')} />;
    }
    return <LoginPage onRegister={registrationOpen ? () => setMode('register') : undefined} />;
  }

  // Authenticated: the remembered route is simply the current URL (the SPA keeps
  // its own in-app tab state), so rendering the app returns the person to it.
  return <>{children}</>;
}
