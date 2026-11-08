import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser, SetupTokenInfo } from './authTypes';

const h = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const apiMock = {
    me: vi.fn(),
    getSetupToken: vi.fn(),
    completeSetup: vi.fn(),
  };
  return { MockApiError, apiMock };
});

const { MockApiError, apiMock } = h;

vi.mock('../services/api', () => ({
  ApiError: h.MockApiError,
  api: h.apiMock,
  onUnauthorized: () => () => {},
}));

// eslint-disable-next-line import/first
import { AuthProvider } from './AuthProvider';
// eslint-disable-next-line import/first
import { SetupPasswordPage } from './SetupPasswordPage';
// eslint-disable-next-line import/first
import { QueryWrapper } from '../queries/testUtils';

const INFO: SetupTokenInfo = {
  email: 'jane@example.com',
  display_name: 'Jane Reader',
  purpose: 'setup',
};
const USER: AuthUser = { id: 2, email: 'jane@example.com', display_name: 'Jane Reader', is_admin: false };

function renderSetup(token = 'tok123', onDone = vi.fn()) {
  apiMock.me.mockRejectedValue(new MockApiError(401, 'no'));
  render(
    <QueryWrapper>
      <AuthProvider>
        <SetupPasswordPage token={token} onDone={onDone} />
      </AuthProvider>
    </QueryWrapper>,
  );
  return onDone;
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});

afterEach(cleanup);

describe('SetupPasswordPage', () => {
  it('valid token: shows who the link is for and sets the password + logs in', async () => {
    apiMock.getSetupToken.mockResolvedValue(INFO);
    apiMock.completeSetup.mockResolvedValue(USER);
    const onDone = renderSetup();

    await screen.findByText(/Jane Reader/);
    expect(screen.getByText(/jane@example.com/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'longenough1' } });
    fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByRole('button', { name: /set password and log in/i }));

    await waitFor(() => expect(apiMock.completeSetup).toHaveBeenCalledWith('tok123', 'longenough1'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('expired token: shows the "ask the admin" message', async () => {
    apiMock.getSetupToken.mockRejectedValue(new MockApiError(410, 'gone'));
    renderSetup();
    const alert = await screen.findByText(/expired or was already used/i);
    expect(alert.textContent).toMatch(/ask the admin/i);
  });

  it('short password: submit is disabled and the min-length hint shows', async () => {
    apiMock.getSetupToken.mockResolvedValue(INFO);
    renderSetup();

    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'short' } });

    expect(screen.getByText(/at least 8 characters/i)).toBeTruthy();
    const submit = screen.getByRole('button', { name: /set password and log in/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(apiMock.completeSetup).not.toHaveBeenCalled();
  });

  it('mismatched passwords: shows the mismatch hint and blocks submit', async () => {
    apiMock.getSetupToken.mockResolvedValue(INFO);
    renderSetup();

    await screen.findByLabelText('New password');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'longenough1' } });
    fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'different123' } });

    expect(screen.getByText(/do not match/i)).toBeTruthy();
    const submit = screen.getByRole('button', { name: /set password and log in/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('new-password autocomplete on both fields', async () => {
    apiMock.getSetupToken.mockResolvedValue(INFO);
    renderSetup();
    const pw = await screen.findByLabelText('New password');
    expect(pw.getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByLabelText('Repeat password').getAttribute('autocomplete')).toBe('new-password');
  });
});
