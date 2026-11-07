import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BookCard } from './BookCard';
import { makeBook } from './testHelpers';
import { SettingsProvider } from '../settings/SettingsContext';
import {
  CARD_FIELDS,
  DETAIL_SECTIONS,
  type CardField,
  type Settings,
} from '../settings/settingsTypes';
import type { Book } from '../types';

const STORAGE_KEY = 'shelfie.settings.v1';

function seedCardFields(overrides: Partial<Record<CardField, boolean>>): void {
  const all = <K extends string>(keys: K[]): Record<K, boolean> =>
    Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;
  const settings: Settings = {
    cardFields: { ...all(CARD_FIELDS), ...overrides },
    detailSections: all(DETAIL_SECTIONS),
    showAllDetails: false,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function renderCard(book: Book) {
  return render(
    <SettingsProvider>
      <BookCard book={book} onOpen={() => {}} />
    </SettingsProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('BookCard — subtitle (series volume title)', () => {
  beforeEach(() => localStorage.clear());

  it('shows the subtitle by default when present', () => {
    seedCardFields({});
    renderCard(makeBook({ title: 'Droga Szamana', subtitle: 'Gambit Kartosa. Etap drugi' }));
    expect(screen.getByText('Droga Szamana')).toBeTruthy();
    expect(screen.getByText('Gambit Kartosa. Etap drugi')).toBeTruthy();
  });

  it('hides the subtitle when the subtitle card field is off', () => {
    seedCardFields({ subtitle: false });
    renderCard(makeBook({ title: 'Droga Szamana', subtitle: 'Gambit Kartosa. Etap drugi' }));
    expect(screen.getByText('Droga Szamana')).toBeTruthy();
    expect(screen.queryByText('Gambit Kartosa. Etap drugi')).toBeNull();
  });

  it('renders no subtitle line when the book has none', () => {
    seedCardFields({});
    const { container } = renderCard(makeBook({ title: 'Dune', subtitle: null }));
    expect(container.querySelector('.card-subtitle')).toBeNull();
  });
});

describe('BookCard — settings-driven fields stay working', () => {
  beforeEach(() => localStorage.clear());

  it('hides author/year when those fields are off', () => {
    seedCardFields({ author: false, year: false });
    renderCard(makeBook({ authors: ['Frank Herbert'], published_date: '1965' }));
    expect(screen.queryByText(/Frank Herbert/)).toBeNull();
  });

  it('shows the series line with volume when enabled', () => {
    seedCardFields({});
    const { container } = renderCard(makeBook({ title: 'Messiah', series: 'Dune', volume: '2' }));
    const series = container.querySelector('.card-series');
    expect(series).toBeTruthy();
    expect(series?.textContent).toContain('Dune');
    expect(series?.textContent).toContain('Vol. 2');
  });
});
