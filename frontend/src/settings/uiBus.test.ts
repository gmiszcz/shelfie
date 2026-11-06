import { describe, expect, it } from 'vitest';

import { parseUiBusEvent } from './uiBus';

describe('parseUiBusEvent', () => {
  it('rejects invalid input', () => {
    expect(parseUiBusEvent(null)).toBeNull();
    expect(parseUiBusEvent('x')).toBeNull();
    expect(parseUiBusEvent({})).toBeNull();
    expect(parseUiBusEvent({ action: 'unknown' })).toBeNull();
  });

  it('parses filter_library and clear_filter verbatim', () => {
    const f = { action: 'filter_library', author: 'Tolkien', min_stars: 4 };
    expect(parseUiBusEvent(f)).toEqual(f);
    expect(parseUiBusEvent({ action: 'clear_filter' })).toEqual({ action: 'clear_filter' });
  });

  it('validates navigate tab', () => {
    expect(parseUiBusEvent({ action: 'navigate', tab: 'stats' })).toEqual({
      action: 'navigate',
      tab: 'stats',
    });
    expect(parseUiBusEvent({ action: 'navigate', tab: 'nope' })).toBeNull();
    expect(parseUiBusEvent({ action: 'navigate' })).toBeNull();
  });

  it('validates open_book id type', () => {
    expect(parseUiBusEvent({ action: 'open_book', book_id: 7 })).toEqual({
      action: 'open_book',
      book_id: 7,
    });
    expect(parseUiBusEvent({ action: 'open_book', book_id: '7' })).toBeNull();
  });
});
