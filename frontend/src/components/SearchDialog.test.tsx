import { cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchDialog } from './SearchDialog';

const search = vi.fn();

vi.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    search: (...a: unknown[]) => search(...a),
  },
}));

function renderDialog(initialQuery?: string) {
  return render(
    <StrictMode>
      <SearchDialog
        visible
        onHide={() => {}}
        onAdd={async () => {}}
        existingVolumeIds={new Set()}
        initialQuery={initialQuery}
      />
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
  search.mockReset();
});

describe('SearchDialog opened by the agent', () => {
  it('types the query AND runs the search once (even under StrictMode)', async () => {
    search.mockResolvedValue({ items: [], notice: null });
    renderDialog('Wiedźmin Sapkowski');
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search.mock.calls[0][0]).toBe('Wiedźmin Sapkowski');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search Google Books"]');
    expect(input?.value).toBe('Wiedźmin Sapkowski');
  });

  it('does not search when opened without a query (the user clicked Add book)', async () => {
    renderDialog(undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(search).not.toHaveBeenCalled();
  });
});
