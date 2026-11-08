import { describe, expect, it } from 'vitest';

import { formatAuthors, formatYear, hitKey } from './format';

describe('formatAuthors', () => {
  it('falls back when empty', () => {
    expect(formatAuthors([])).toBe('Unknown author');
  });
  it('joins one or two authors', () => {
    expect(formatAuthors(['A'])).toBe('A');
    expect(formatAuthors(['A', 'B'])).toBe('A & B');
  });
  it('summarizes three or more', () => {
    expect(formatAuthors(['A', 'B', 'C'])).toBe('A +2');
  });
});

describe('formatYear', () => {
  it('extracts the year', () => {
    expect(formatYear('1965-06-01')).toBe('1965');
    expect(formatYear('2001')).toBe('2001');
  });
  it('handles null', () => {
    expect(formatYear(null)).toBe('');
  });
});

describe('hitKey', () => {
  it('uses volume id when present', () => {
    expect(
      hitKey({ google_volume_id: 'v1' } as never, 0),
    ).toBe('v1');
  });
  it('falls back to title + index', () => {
    expect(
      hitKey({ google_volume_id: null, title: 'Dune' } as never, 3),
    ).toBe('Dune-3');
  });
});
