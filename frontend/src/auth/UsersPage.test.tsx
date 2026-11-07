import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminUser, AuthUser, CreatedUser } from './authTypes';

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
    logout: vi.fn(),
    changePassword: vi.fn(),
    listUsers: vi.fn(),
    addUser: vi.fn(),
    updateUser: vi.fn(),
    newSetupLink: vi.fn(),
  };
  return { MockApiError, apiMock };
});

const { apiMock } = h;

vi.mock('../services/api', () => ({
  ApiError: h.MockApiError,
  api: h.apiMock,
  onUnauthorized: () => () => {},
}));

// eslint-disable-next-line import/first
import { AuthProvider } from './AuthProvider';
// eslint-disable-next-line import/first
import { UserMenu } from './UserMenu';
// eslint-disable-next-line import/first
import { UsersPage } from './UsersPage';

const ADMIN: AuthUser = { id: 1, email: 'admin@shelfie.app', display_name: 'Patryk Batóg', is_admin: true };
const MEMBER: AuthUser = { id: 2, email: 'jane@example.com', display_name: 'Jane Reader', is_admin: false };

function renderMenu(who: AuthUser) {
  apiMock.me.mockResolvedValue(who);
  const onOpenUsers = vi.fn();
  render(
    <AuthProvider>
      <UserMenu onOpenUsers={onOpenUsers} />
    </AuthProvider>,
  );
  return onOpenUsers;
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  // Clipboard stub for the copy button.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(cleanup);

describe('UserMenu — admin-only Users entry', () => {
  it('shows "Users" for an admin', async () => {
    renderMenu(ADMIN);
    // Wait until me() resolved and the trigger rendered.
    const trigger = await screen.findByRole('button', { name: /account: patryk/i });
    fireEvent.click(trigger);
    await screen.findByText('Change password');
    expect(screen.getByText('Users')).toBeTruthy();
    expect(screen.getByText('Log out')).toBeTruthy();
  });

  it('hides "Users" for a non-admin', async () => {
    renderMenu(MEMBER);
    const trigger = await screen.findByRole('button', { name: /account: jane/i });
    fireEvent.click(trigger);
    await screen.findByText('Change password');
    expect(screen.queryByText('Users')).toBeNull();
    // Non-admins still get change-password and log out.
    expect(screen.getByText('Log out')).toBeTruthy();
  });
});

describe('UsersPage — add person shows a copyable link', () => {
  const EXISTING: AdminUser[] = [
    {
      id: 1,
      email: 'admin@shelfie.app',
      display_name: 'Patryk Batóg',
      is_admin: true,
      disabled: false,
      has_password: true,
      created_at: '2026-01-01T00:00:00Z',
      book_count: 1200,
    },
  ];
  const CREATED: CreatedUser = {
    user: {
      id: 2,
      email: 'jane@example.com',
      display_name: 'Jane Reader',
      is_admin: false,
      disabled: false,
      has_password: false,
      created_at: '2026-11-07T10:00:00Z',
      book_count: 0,
    },
    setup_url: 'https://shelfie.app/setup?token=abc123',
    expires_at: '2026-11-08T10:00:00Z',
  };

  it('opens the dialog, creates a person and shows the setup link with a Copy button', async () => {
    apiMock.me.mockResolvedValue(ADMIN);
    apiMock.listUsers.mockResolvedValue(EXISTING);
    apiMock.addUser.mockResolvedValue(CREATED);

    render(
      <AuthProvider>
        <UsersPage />
      </AuthProvider>,
    );

    // The existing admin row loads.
    await screen.findAllByText(/Patryk Batóg/);

    fireEvent.click(screen.getByRole('button', { name: /add person/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Jane Reader' } });
    fireEvent.change(within(dialog).getByLabelText('E-mail'), { target: { value: 'jane@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^add person$/i }));

    // The returned setup_url is shown in a readonly field with a Copy button.
    const linkInput = (await screen.findByLabelText('Setup link')) as HTMLInputElement;
    expect(linkInput.value).toBe('https://shelfie.app/setup?token=abc123');

    const copyBtn = screen.getByRole('button', { name: /copy/i });
    fireEvent.click(copyBtn);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://shelfie.app/setup?token=abc123',
      ),
    );
    expect(apiMock.addUser).toHaveBeenCalledWith('jane@example.com', 'Jane Reader');
  });
});
