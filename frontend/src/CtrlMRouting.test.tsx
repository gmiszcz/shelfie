import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from './components/testHelpers';
import type { Book } from './types';
import type { MicButtonProps, MicHandle, MicVariant } from './components/MicButton';

/**
 * Ctrl+M routing: the shell owns ONE Ctrl+M listener and routes it to the chat
 * mic when the panel is open and to the global mic when it is closed, so no mic
 * double-fires. MicButton is mocked to a stub that records a `toggle` spy per
 * variant (chat / global) and forwards the imperative handle the shell drives.
 */

const BOOKS: Book[] = [makeBook({ id: 1, title: 'Dune' })];

// toggle spies keyed by the mic variant the shell published.
const toggles: Record<MicVariant, ReturnType<typeof vi.fn>> = {
  chat: vi.fn(),
  global: vi.fn(),
};
let recording: MicVariant | null = null;

vi.mock('./components/MicButton', async () => {
  const React = await import('react');
  return {
    MicButton: React.forwardRef<MicHandle, MicButtonProps>(function MockMic(props, ref) {
      const variant: MicVariant = props.variant ?? 'chat';
      React.useImperativeHandle(ref, () => ({
        toggle: () => toggles[variant](),
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        isRecording: () => recording === variant,
      }));
      return <div data-testid={`mic-${variant}`} />;
    }),
  };
});

vi.mock('./services/api', () => ({
  ApiError: class ApiError extends Error {},
  onUnauthorized: () => () => {},
  api: {
    me: vi.fn(async () => ({ id: 1, email: 'admin@shelfie.app', display_name: 'Admin', is_admin: true })),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    listUsers: vi.fn(async () => []),
    listBooks: vi.fn(async () => BOOKS),
    updateBook: vi.fn(async () => BOOKS[0]),
    deleteBook: vi.fn(async () => undefined),
    addBook: vi.fn(async () => BOOKS[0]),
    search: vi.fn(async () => ({ total_items: 0, items: [] })),
    stats: vi.fn(async () => ({
      date_from: null,
      date_to: null,
      group_by: 'shelf',
      summary: { books: 0, pages: 0, average_stars: null, first_finished: null, last_finished: null },
      buckets: [],
      books: [],
    })),
    recomputeRatings: vi.fn(async () => ({ rated_books: 0, comparisons: 0 })),
    nextPair: vi.fn(async () => null),
    nextPairs: vi.fn(async () => []),
    listSeries: vi.fn(async () => []),
    listExpected: vi.fn(async () => []),
    seriesAlerts: vi.fn(async () => ({ count: 0, unseen_count: 0, in_progress: [], new_volume: [] })),
    getSeriesPreferences: vi.fn(async () => ({ filter: null, sort: null })),
    putSeriesPreferences: vi.fn(async () => undefined),
    chat: vi.fn(),
    resetChat: vi.fn(async () => undefined),
  },
}));

// eslint-disable-next-line import/first
import App from './App';
// eslint-disable-next-line import/first
import { AuthProvider } from './auth';
// eslint-disable-next-line import/first
import { QueryWrapper } from './queries/testUtils';

/** Render the app wrapped in the auth provider (authenticated via the api mock). */
function renderApp() {
  return render(
    <QueryWrapper>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryWrapper>,
  );
}

function ctrlM() {
  fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  toggles.chat.mockClear();
  toggles.global.mockClear();
  recording = null;
});

afterEach(() => cleanup());

describe('Ctrl+M routing', () => {
  it('toggles the GLOBAL mic when the chat panel is closed', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('mic-global')).toBeTruthy());
    // Panel is closed on first render, so the chat mic is not even mounted.
    expect(screen.queryByTestId('mic-chat')).toBeNull();

    act(() => ctrlM());

    expect(toggles.global).toHaveBeenCalledTimes(1);
    expect(toggles.chat).not.toHaveBeenCalled();
  });

  it('toggles the CHAT mic when the chat panel is open', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('mic-global')).toBeTruthy());

    // Open the chat via its FAB.
    act(() => {
      fireEvent.click(screen.getByLabelText(/open assistant/i));
    });
    await waitFor(() => expect(screen.getByTestId('mic-chat')).toBeTruthy());

    act(() => ctrlM());

    expect(toggles.chat).toHaveBeenCalledTimes(1);
    expect(toggles.global).not.toHaveBeenCalled();
  });
});

