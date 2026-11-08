import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SeriesEditDialog } from './SeriesEditDialog';
import { makeBook } from './testHelpers';
import type { SeriesSummary } from '../types';

const renameSeries = vi.fn();
const updateSeries = vi.fn();
const addSeriesBook = vi.fn();
const removeSeriesBook = vi.fn();
const setSeriesBookVolume = vi.fn();
const mergeSeries = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    renameSeries: (...a: unknown[]) => renameSeries(...a),
    updateSeries: (...a: unknown[]) => updateSeries(...a),
    addSeriesBook: (...a: unknown[]) => addSeriesBook(...a),
    removeSeriesBook: (...a: unknown[]) => removeSeriesBook(...a),
    setSeriesBookVolume: (...a: unknown[]) => setSeriesBookVolume(...a),
    mergeSeries: (...a: unknown[]) => mergeSeries(...a),
  },
}));

function makeSeries(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    series_key: 'the way of shaman',
    name: 'The Way of the Shaman',
    author: 'Vasily Mahanenko',
    aliases: ['Droga Szamana'],
    owned_volumes: [
      {
        book_id: 10,
        volume: 1,
        volume_label: '1',
        title: 'Survival Quest',
        cover_url: null,
        status: 'finished',
        read: true,
        favourite: false,
        finished_on: '2022-01-01',
      },
    ],
    missing_volumes: [],
    owned_count: 1,
    read_count: 1,
    unread_owned_count: 0,
    total_known: 7,
    section: 'in_progress',
    started: true,
    finished: false,
    watch: false,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: null,
    notes: null,
    search_lang: 'pl',
    release_summary: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe('SeriesEditDialog', () => {
  const onSaved = vi.fn();
  const onError = vi.fn();
  const onHide = vi.fn();

  beforeEach(() => {
    renameSeries.mockReset().mockResolvedValue(makeSeries());
    updateSeries.mockReset().mockResolvedValue(makeSeries());
    addSeriesBook.mockReset().mockResolvedValue(makeSeries());
    removeSeriesBook.mockReset().mockResolvedValue(makeSeries());
    setSeriesBookVolume.mockReset().mockResolvedValue(makeSeries());
    mergeSeries.mockReset().mockResolvedValue(makeSeries());
    onSaved.mockReset();
    onError.mockReset();
    onHide.mockReset();
  });

  function renderDialog(series = makeSeries(), books = [makeBook({ id: 20, title: 'New Volume', authors: ['Vasily Mahanenko'], series: null })]) {
    return render(
      <SeriesEditDialog
        series={series}
        allSeries={[series, makeSeries({ series_key: 'other', name: 'Other Saga', aliases: [] })]}
        books={books}
        onHide={onHide}
        onSaved={onSaved}
        onError={onError}
      />,
    );
  }

  it('shows the series fields and member books', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByDisplayValue('The Way of the Shaman')).toBeTruthy();
    expect(within(dialog).getByDisplayValue('Vasily Mahanenko')).toBeTruthy();
    expect(within(dialog).getByText('Survival Quest')).toBeTruthy();
  });

  it('saving metadata with a new name renames then updates', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByDisplayValue('The Way of the Shaman');
    fireEvent.change(nameInput, { target: { value: 'Droga Szamana' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameSeries).toHaveBeenCalledWith('the way of shaman', 'Droga Szamana'));
    expect(updateSeries).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith('Series saved');
  });

  it('changing a member volume on blur calls setSeriesBookVolume', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const volInput = within(dialog).getByLabelText('Volume of Survival Quest');
    fireEvent.change(volInput, { target: { value: '2' } });
    fireEvent.blur(volInput);
    await waitFor(() => expect(setSeriesBookVolume).toHaveBeenCalledWith('the way of shaman', 10, '2'));
  });

  it('removing a member calls removeSeriesBook', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Survival Quest from the series' }));
    await waitFor(() => expect(removeSeriesBook).toHaveBeenCalledWith('the way of shaman', 10));
  });

  it('adding a book from the library search calls addSeriesBook', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const search = within(dialog).getByLabelText('Search the library to add a book to this series');
    fireEvent.change(search, { target: { value: 'New Volume' } });
    // Pick the candidate.
    const candidate = await within(dialog).findByText('New Volume');
    fireEvent.click(candidate);
    const volInput = within(dialog).getByLabelText('Volume for the added book');
    fireEvent.change(volInput, { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to series' }));
    await waitFor(() => expect(addSeriesBook).toHaveBeenCalledWith('the way of shaman', 20, '8'));
  });
});
