import { describe, expect, it } from 'vitest';

import type { Book } from './types';
import { emptyForm, fromBook, toInput, toLocalDate, validate } from './bookForm';

describe('fromBook', () => {
  it('returns an empty form for null', () => {
    const f = fromBook(null);
    expect(f.title).toBe('');
    expect(f.authors).toEqual([]);
    expect(f.stars).toBeNull();
    expect(f.started_on).toBeNull();
    expect(f.status).toBe('want');
    expect(f.copies).toBe(1);
  });

  it('hydrates scalar, list and date fields', () => {
    const f = fromBook({
      title: 'Dune',
      authors: ['Frank Herbert'],
      page_count: 412,
      stars: 4.5,
      started_on: '2024-03-01',
      finished_on: '2024-03-20',
      status: 'finished',
    });
    expect(f.title).toBe('Dune');
    expect(f.authors).toEqual(['Frank Herbert']);
    expect(f.page_count).toBe(412);
    expect(f.stars).toBe(4.5);
    expect(f.status).toBe('finished');
    expect(f.started_on).toBeInstanceOf(Date);
    expect(toLocalDate(f.started_on!)).toBe('2024-03-01');
    expect(toLocalDate(f.finished_on!)).toBe('2024-03-20');
  });

  it('parses dates in local time (no UTC shift)', () => {
    const f = fromBook({ started_on: '2024-01-01' });
    expect(f.started_on!.getFullYear()).toBe(2024);
    expect(f.started_on!.getMonth()).toBe(0);
    expect(f.started_on!.getDate()).toBe(1);
  });

  it('copies a list rather than aliasing it', () => {
    const authors = ['A'];
    const f = fromBook({ authors });
    f.authors.push('B');
    expect(authors).toEqual(['A']);
  });

  it('accepts a full Book shape', () => {
    const book = {
      id: 1,
      title: 'Hyperion',
      authors: ['Dan Simmons'],
      cover_url: 'https://x/c.jpg',
    } as unknown as Book;
    const f = fromBook(book);
    expect(f.title).toBe('Hyperion');
    expect(f.cover_url).toBe('https://x/c.jpg');
  });
});

describe('toInput', () => {
  it('trims strings and turns blanks into null', () => {
    const f = emptyForm();
    f.title = '  Dune  ';
    f.subtitle = '   ';
    f.publisher = ' Ace ';
    const input = toInput(f);
    expect(input.title).toBe('Dune');
    expect(input.subtitle).toBeNull();
    expect(input.publisher).toBe('Ace');
  });

  it('cleans list fields', () => {
    const f = emptyForm();
    f.authors = ['  Frank Herbert ', '', '  '];
    f.tags = ['sci-fi', ' ', 'classic'];
    const input = toInput(f);
    expect(input.authors).toEqual(['Frank Herbert']);
    expect(input.tags).toEqual(['sci-fi', 'classic']);
  });

  it('formats dates as local YYYY-MM-DD', () => {
    const f = emptyForm();
    f.title = 'X';
    f.started_on = new Date(2024, 11, 31);
    f.finished_on = null;
    const input = toInput(f);
    expect(input.started_on).toBe('2024-12-31');
    expect(input.finished_on).toBeNull();
  });

  it('preserves null numbers and cover_url', () => {
    const f = emptyForm();
    f.title = 'X';
    const input = toInput(f);
    expect(input.page_count).toBeNull();
    expect(input.stars).toBeNull();
    expect(input.cover_url).toBeNull();
  });

  it('sends null insights when the block is empty', () => {
    const f = emptyForm();
    f.title = 'X';
    expect(toInput(f).insights).toBeNull();
  });

  it('marks edited insights as user-authored', () => {
    const f = emptyForm();
    f.title = 'X';
    f.insights.summary = '  A summary  ';
    f.insights.tone = '';
    const input = toInput(f);
    expect(input.insights?.summary).toBe('A summary');
    expect(input.insights?.tone).toBeNull();
    expect(input.insights?.source).toBe('user');
  });

  it('keeps agent origin and timestamp when insights are unchanged', () => {
    const f = fromBook({
      title: 'X',
      insights: {
        summary: 'Agent summary',
        main_characters: null,
        main_plot: null,
        setting: null,
        themes: null,
        tone: null,
        generated_at: '2026-11-06T00:00:00+00:00',
        source: 'agent',
      },
    });
    const input = toInput(f);
    expect(input.insights?.source).toBe('agent');
    expect(input.insights?.generated_at).toBe('2026-11-06T00:00:00+00:00');
    expect(input.insights?.summary).toBe('Agent summary');
  });
});

describe('toLocalDate', () => {
  it('zero-pads month and day', () => {
    expect(toLocalDate(new Date(2024, 0, 5))).toBe('2024-01-05');
    expect(toLocalDate(new Date(1999, 8, 9))).toBe('1999-09-09');
  });
});

describe('validate', () => {
  it('requires a title', () => {
    const f = emptyForm();
    f.title = '   ';
    expect(validate(f).title).toBeDefined();
  });

  it('rejects an over-long title', () => {
    const f = emptyForm();
    f.title = 'a'.repeat(501);
    expect(validate(f).title).toBeDefined();
  });

  it('accepts a valid title', () => {
    const f = emptyForm();
    f.title = 'Dune';
    expect(validate(f).title).toBeUndefined();
  });

  it('rejects stars outside 0.5-5', () => {
    const f = emptyForm();
    f.title = 'X';
    f.stars = 0.25;
    expect(validate(f).stars).toBeDefined();
    f.stars = 5.5;
    expect(validate(f).stars).toBeDefined();
    f.stars = 0.5;
    expect(validate(f).stars).toBeUndefined();
    f.stars = 5;
    expect(validate(f).stars).toBeUndefined();
    f.stars = null;
    expect(validate(f).stars).toBeUndefined();
  });

  it('rejects a finished date before the started date', () => {
    const f = emptyForm();
    f.title = 'X';
    f.started_on = new Date(2024, 2, 10);
    f.finished_on = new Date(2024, 2, 1);
    expect(validate(f).finished_on).toBeDefined();
  });

  it('accepts a finished date equal to or after the started date', () => {
    const f = emptyForm();
    f.title = 'X';
    f.started_on = new Date(2024, 2, 1);
    f.finished_on = new Date(2024, 2, 1);
    expect(validate(f).finished_on).toBeUndefined();
    f.finished_on = new Date(2024, 2, 10);
    expect(validate(f).finished_on).toBeUndefined();
  });

  it('rejects negative counts', () => {
    const f = emptyForm();
    f.title = 'X';
    f.page_count = -1;
    f.pages_read = -2;
    f.copies = -1;
    f.purchase_price = -5;
    const errors = validate(f);
    expect(errors.page_count).toBeDefined();
    expect(errors.pages_read).toBeDefined();
    expect(errors.copies).toBeDefined();
    expect(errors.purchase_price).toBeDefined();
  });

  it('returns an empty map for a fully valid form', () => {
    const f = emptyForm();
    f.title = 'Dune';
    f.stars = 4.5;
    f.page_count = 412;
    expect(validate(f)).toEqual({});
  });
});
