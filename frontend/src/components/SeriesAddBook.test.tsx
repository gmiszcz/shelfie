import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeBook } from './testHelpers';
import type { SeriesSummary } from '../types';

const addSeriesBook = vi.fn();
vi.mock('../services/api', () => ({
  api: { addSeriesBook: (...a: unknown[]) => addSeriesBook(...a) },
}));

// eslint-disable-next-line import/first
import { SeriesAddBook } from './SeriesAddBook';

const BOOKS = [
  makeBook({ id: 1, title: 'Dwór cierni i róż', authors: ['Sarah J. Maas'], series: null, added_at: '2026-11-08' }),
  makeBook({ id: 2, title: 'Diuna', authors: ['Frank Herbert'], series: 'Dune', added_at: '2026-11-01' }),
];

afterEach(() => {
  cleanup();
  addSeriesBook.mockReset();
});

describe('SeriesAddBook', () => {
  it('lists only books without a series and adds one to a NEW series, then watches it', async () => {
    addSeriesBook.mockResolvedValue({ series_key: 'acotar', name: 'ACOTAR', watch: false } as SeriesSummary);
    const onWatch = vi.fn(async () => {});
    const onDone = vi.fn();
    render(<SeriesAddBook books={BOOKS} series={[]} onWatch={onWatch} onDone={onDone} onError={() => {}} />);

    expect(screen.queryByText('Diuna')).toBeNull();
    fireEvent.click(screen.getByText('Dwór cierni i róż'));
    fireEvent.change(screen.getByLabelText('Series name'), { target: { value: 'ACOTAR' } });
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to series' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(addSeriesBook).toHaveBeenCalledWith('ACOTAR', 1, '1');
    expect(onWatch).toHaveBeenCalledWith('acotar');
  });
});
