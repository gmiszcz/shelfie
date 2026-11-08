import type { Book } from '../types';

/**
 * Build a fully-populated {@link Book} for component tests, overridable per field.
 * Defaults carry content in every optional section so detail-dialog tests can
 * assert each section is shown/hidden purely via settings, not missing data.
 */
export function makeBook(overrides: Partial<Book> = {}): Book {
  const base: Book = {
    id: 1,
    google_volume_id: 'vol-1',
    external_id: null,
    title: 'Dune',
    subtitle: 'The classic',
    authors: ['Frank Herbert'],
    translators: [],
    publisher: 'Chilton',
    published_date: '1965',
    description: 'A desert planet and a spice.',
    page_count: 412,
    categories: ['Science Fiction'],
    language: 'en',
    isbn_10: null,
    isbn_13: null,
    cover_url: null,
    format: 'Hardcover',
    edition: 'First',
    series: 'Dune',
    volume: '1',
    status: 'finished',
    stars: 5,
    started_on: '2024-03-01',
    finished_on: '2024-03-20',
    pages_read: 412,
    shelves: ['sci-fi'],
    tags: ['favourite'],
    review: 'A review.',
    notes: 'Some notes.',
    quotes: 'A quote.',
    insights: {
      summary: 'A summary.',
      main_characters: 'Paul Atreides',
      main_plot: 'The plot.',
      setting: 'Arrakis',
      themes: 'Power',
      tone: 'Epic',
      generated_at: null,
      source: 'agent',
    },
    signed: true,
    favourite: true,
    condition: 'Good',
    copies: 1,
    purchase_date: '2024-02-01',
    purchase_price: 25,
    purchase_from: 'A shop',
    metadata_source: 'manual',
    latent_strength: null,
    rating_uncertainty: null,
    display_score: 4.8,
    comparison_count: 3,
    added_at: '2024-01-01',
    updated_at: '2024-01-01',
  };
  return { ...base, ...overrides };
}
