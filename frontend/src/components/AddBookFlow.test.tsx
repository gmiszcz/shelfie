import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listBooks: vi.fn(async () => []),
    search: vi.fn(async () => ({ total_items: 0, items: [] })),
  },
}));

// eslint-disable-next-line import/first
import { AddBookFlow, addBookStore } from './AddBookFlow';
// eslint-disable-next-line import/first
import { SettingsProvider } from '../settings/SettingsContext';
// eslint-disable-next-line import/first
import { QueryWrapper } from '../queries/testUtils';
// eslint-disable-next-line import/first
import { _resetRegistry, getAnchorState, invokeAnchor } from '../agent-ui';

function renderFlow() {
  render(
    <QueryWrapper>
      <SettingsProvider>
        <AddBookFlow />
      </SettingsProvider>
    </QueryWrapper>,
  );
}

afterEach(() => {
  cleanup();
  act(() => addBookStore.close());
  _resetRegistry();
});

describe('AddBookFlow (the always-visible + button)', () => {
  it('the + button opens the Google Books search, which offers Add manually', async () => {
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Add book' }));
    await waitFor(() => expect(screen.getByText('Add a book from Google Books')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add manually' }));
    await waitFor(() => expect(getAnchorState('library.addBook').value).toBe('form'));
  });

  it('library.addBook is a global anchor (no tab) with search / manual / close', async () => {
    renderFlow();
    await act(async () => {
      await invokeAnchor('library.addBook', 'manual');
    });
    expect(getAnchorState('library.addBook').value).toBe('form');
    await act(async () => {
      await invokeAnchor('library.addBook', 'close');
    });
    expect(getAnchorState('library.addBook').value).toBe('closed');
  });
});
