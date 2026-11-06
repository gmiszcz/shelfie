import { describe, expect, it } from 'vitest';

import { describeAction } from './labels';

describe('describeAction', () => {
  it('labels navigation to a tab', () => {
    expect(describeAction('navigate', { tab: 'ranking' })).toBe('Go to Ranking');
  });

  it('labels a library series filter', () => {
    expect(describeAction('filter_library', { series: 'Droga Szamana' })).toBe(
      'Filter library: series Droga Szamana',
    );
  });

  it('labels a star filter and its clear', () => {
    expect(describeAction('set_star_filter', { stars: 5 })).toBe('Filter 5★');
    expect(describeAction('set_star_filter', { stars: null })).toBe('Clear star filter');
  });

  it('labels open_add_book with mode and query', () => {
    expect(describeAction('open_add_book', { mode: 'search', query: 'Diuna' })).toBe(
      'Add a book (search "Diuna")',
    );
    expect(describeAction('open_add_book', { mode: 'manual' })).toBe('Add a book (manual form)');
  });

  it('labels find_books and set_search', () => {
    expect(describeAction('find_books', { query: 'Herbert' })).toBe('Find books "Herbert"');
    expect(describeAction('set_search', { query: 'dune' })).toBe('Search library "dune"');
  });

  it('falls back to the tool name for an unknown tool', () => {
    expect(describeAction('mystery', {})).toBe('mystery');
  });
});
