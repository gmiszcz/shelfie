import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SeriesCard } from './SeriesCard';
import type { ReleaseSummary, SeriesSummary } from '../types';

function makeSeries(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    series_key: 'the wandering inn',
    name: 'The Wandering Inn',
    author: 'pirateaba',
    aliases: [],
    owned_volumes: [],
    missing_volumes: [],
    owned_count: 3,
    read_count: 1,
    unread_owned_count: 2,
    total_known: 10,
    section: 'in_progress',
    started: true,
    finished: false,
    watch: true,
    next_expected: null,
    next_expected_pl: null,
    next_expected_en: null,
    checking: false,
    last_checked: '2026-02-01T00:00:00Z',
    notes: null,
    search_lang: 'pl',
    release_summary: null,
    ...overrides,
  };
}

const releaseSummary: ReleaseSummary = {
  status: 'announced',
  headline: 'Tom 7 zapowiedziany na 2026.',
  next_title: 'Volume 7',
  next_volume: 7,
  expected_date: '2026',
  details: [],
  editions: {},
  added_book_id: null,
  checked_at: null,
};

afterEach(cleanup);

describe('SeriesCard language + refresh', () => {
  const handlers = () => ({
    onOpenVolume: vi.fn(),
    onToggleWatch: vi.fn(),
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onSetLang: vi.fn(),
  });

  it('renders the PL|EN|Both control reflecting the series search_lang', () => {
    const h = handlers();
    render(<SeriesCard series={makeSeries({ search_lang: 'en' })} {...h} refreshing={false} />);
    const en = screen.getByRole('radio', { name: 'EN' });
    expect(en.getAttribute('aria-checked')).toBe('true');
  });

  it('calls onSetLang with the series key and the chosen language', () => {
    const h = handlers();
    render(<SeriesCard series={makeSeries({ search_lang: 'pl' })} {...h} refreshing={false} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Both' }));
    expect(h.onSetLang).toHaveBeenCalledWith('the wandering inn', 'both');
  });

  it('refresh passes the current search language through', () => {
    const h = handlers();
    render(<SeriesCard series={makeSeries({ search_lang: 'both' })} {...h} refreshing={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh The Wandering Inn' }));
    expect(h.onRefresh).toHaveBeenCalledWith('the wandering inn', 'both');
  });

  it('renders the release headline for a watched series with a summary', () => {
    const h = handlers();
    render(
      <SeriesCard series={makeSeries({ release_summary: releaseSummary })} {...h} refreshing={false} />,
    );
    expect(screen.getByText('Tom 7 zapowiedziany na 2026.')).toBeTruthy();
  });

  it('shows "Not checked yet" for a watched series without a summary', () => {
    const h = handlers();
    render(<SeriesCard series={makeSeries({ release_summary: null })} {...h} refreshing={false} />);
    expect(screen.getByText('Not checked yet')).toBeTruthy();
  });
});
