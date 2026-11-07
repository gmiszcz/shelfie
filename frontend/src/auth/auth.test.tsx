import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from './authTypes';

// All state the vi.mock factory touches must be hoisted (the factory runs before
// top-level code). vi.hoisted gives us that shared, pre-initialised state.
const h = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    retryAfter?: number;
    constructor(status: number, message: string, retryAfter?: number) {
      super(message);
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }
  const unauthorizedListeners = new Set<() => void>();
  const apiMock = {
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    getSetupToken: vi.fn(),
    completeSetup: vi.fn(),
    listUsers: vi.fn(),
    addUser: vi.fn(),
    updateUser: vi.fn(),
    newSetupLink: vi.fn(),
  };
  return { MockApiError, unauthorizedListeners, apiMock };
});

const { MockApiError, unauthorizedListeners, apiMock } = h;

const ADMIN: AuthUser = { id: 1, email: 'admin@shelfie.app', display_name: 'Patryk Batóg', is_admin: true };

vi.mock('../services/api', () => ({
  ApiError: h.MockApiError,
  api: h.apiMock,
  onUnauthorized: (fn: () => void) => {
    h.unauthorizedListeners.add(fn);
    return () => h.unauthorizedListeners.delete(fn);
  },
}));

// eslint-disable-next-line import/first
import { AuthProvider, useAuth } from './AuthProvider';
// eslint-disable-next-line import/first
import { AuthGate } from './AuthGate';
// eslint-disable-next-line import/first
import { LoginPage } from './LoginPage';

/** Fire a global 401 the way api.ts would. */
function emitUnauthorized() {
  for (const fn of unauthorizedListeners) fn();
}

/** A trivial protected app body with a logout button, used to prove the gate. */
function ProtectedApp() {
  const { logout, user } = useAuth();
  return (
    <div>
      <div>LIBRARY for {user?.display_name}</div>
      <button onClick={() => void logout()}>do-logout</button>
    </div>
  );
}

beforeEach(() => {
  unauthorizedListeners.clear();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('LoginPage', () => {
  it('logs in successfully and shows the app (login success)', async () => {
    apiMock.me.mockRejectedValue(new MockApiError(401, 'no'));
    apiMock.login.mockResolvedValue(ADMIN);

    render(
      <AuthProvider>
        <AuthGate>
          <ProtectedApp />
        </AuthGate>
      </AuthProvider>,
    );

    // Starts anonymous → the login form shows.
    await screen.findByLabelText('E-mail');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'admin@shelfie.app' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await screen.findByText(/LIBRARY for Patryk/);
    expect(apiMock.login).toHaveBeenCalledWith('admin@shelfie.app', 'hunter2hunter2');
  });

  it('shows a generic inline error on invalid credentials (login failure)', async () => {
    apiMock.me.mockRejectedValue(new MockApiError(401, 'no'));
    apiMock.login.mockRejectedValue(new MockApiError(401, 'Invalid e-mail or password'));

    render(
      <AuthProvider>
        <AuthGate>
          <ProtectedApp />
        </AuthGate>
      </AuthProvider>,
    );

    await screen.findByLabelText('E-mail');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'x@y.z' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Invalid e-mail or password/i);
    expect(screen.queryByText(/LIBRARY for/)).toBeNull();
  });

  it('shows the throttle message with the wait time on 429', async () => {
    apiMock.me.mockRejectedValue(new MockApiError(401, 'no'));
    apiMock.login.mockRejectedValue(new MockApiError(429, 'slow down', 120));

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    await screen.findByLabelText('E-mail');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'x@y.z' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many attempts/i);
    expect(alert.textContent).toMatch(/2 minutes/i);
  });

  it('has email and current-password autocomplete attributes', async () => {
    apiMock.me.mockRejectedValue(new MockApiError(401, 'no'));
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    const email = await screen.findByLabelText('E-mail');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  });
});

describe('AuthGate 401 handling', () => {
  it('a 401 sends the app back to login, then logging in returns to the app', async () => {
    apiMock.me.mockResolvedValue(ADMIN);
    apiMock.login.mockResolvedValue(ADMIN);

    render(
      <AuthProvider>
        <AuthGate>
          <ProtectedApp />
        </AuthGate>
      </AuthProvider>,
    );

    // Authenticated at first.
    await screen.findByText(/LIBRARY for Patryk/);

    // A session-expiry 401 fires → back to login.
    emitUnauthorized();
    await screen.findByLabelText('E-mail');
    expect(screen.queryByText(/LIBRARY for/)).toBeNull();

    // Logging back in returns to the app (same route is still '/').
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'admin@shelfie.app' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    await screen.findByText(/LIBRARY for Patryk/);
  });

  it('logout clears state and shows the login page', async () => {
    apiMock.me.mockResolvedValue(ADMIN);
    apiMock.logout.mockResolvedValue(undefined);

    render(
      <AuthProvider>
        <AuthGate>
          <ProtectedApp />
        </AuthGate>
      </AuthProvider>,
    );

    await screen.findByText(/LIBRARY for Patryk/);
    fireEvent.click(screen.getByText('do-logout'));
    await screen.findByLabelText('E-mail');
    expect(apiMock.logout).toHaveBeenCalled();
    expect(screen.queryByText(/LIBRARY for/)).toBeNull();
  });
});
