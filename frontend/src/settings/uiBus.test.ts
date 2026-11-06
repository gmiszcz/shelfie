import { describe, expect, it, vi } from 'vitest';

import { UI_BUS_ACK_EVENT, dispatchUiAck, parseUiBusEvent } from './uiBus';

describe('parseUiBusEvent (v1)', () => {
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

describe('parseUiBusEvent (v2)', () => {
  it('set_search requires a string query', () => {
    expect(parseUiBusEvent({ action: 'set_search', query: 'dune' })).toEqual({
      action: 'set_search',
      query: 'dune',
    });
    expect(parseUiBusEvent({ action: 'set_search', query: 5 })).toBeNull();
  });

  it('set_star_filter accepts 1..5 whole stars and null, rejects halves/out of range', () => {
    expect(parseUiBusEvent({ action: 'set_star_filter', stars: 5 })).toEqual({
      action: 'set_star_filter',
      stars: 5,
    });
    expect(parseUiBusEvent({ action: 'set_star_filter', stars: null })).toEqual({
      action: 'set_star_filter',
      stars: null,
    });
    expect(parseUiBusEvent({ action: 'set_star_filter', stars: 4.5 })).toBeNull();
    expect(parseUiBusEvent({ action: 'set_star_filter', stars: 0 })).toBeNull();
    expect(parseUiBusEvent({ action: 'set_star_filter', stars: 6 })).toBeNull();
  });

  it('open_add_book validates mode and carries optional query/prefill', () => {
    expect(parseUiBusEvent({ action: 'open_add_book', mode: 'search', query: 'sci-fi' })).toEqual({
      action: 'open_add_book',
      mode: 'search',
      query: 'sci-fi',
    });
    expect(
      parseUiBusEvent({ action: 'open_add_book', mode: 'manual', prefill: { title: 'X' } }),
    ).toEqual({ action: 'open_add_book', mode: 'manual', prefill: { title: 'X' } });
    expect(parseUiBusEvent({ action: 'open_add_book', mode: 'bogus' })).toBeNull();
  });

  it('open_settings / close_dialogs / toggle_theme parse verbatim', () => {
    expect(parseUiBusEvent({ action: 'open_settings' })).toEqual({ action: 'open_settings' });
    expect(parseUiBusEvent({ action: 'close_dialogs' })).toEqual({ action: 'close_dialogs' });
    expect(parseUiBusEvent({ action: 'toggle_theme' })).toEqual({ action: 'toggle_theme' });
  });

  it('set_setting requires a string key and boolean value', () => {
    expect(parseUiBusEvent({ action: 'set_setting', key: 'insights', value: false })).toEqual({
      action: 'set_setting',
      key: 'insights',
      value: false,
    });
    expect(parseUiBusEvent({ action: 'set_setting', key: 'insights', value: 'no' })).toBeNull();
    expect(parseUiBusEvent({ action: 'set_setting', value: true })).toBeNull();
  });

  it('ranking requires a string query', () => {
    expect(parseUiBusEvent({ action: 'ranking', query: 'war' })).toEqual({
      action: 'ranking',
      query: 'war',
    });
    expect(parseUiBusEvent({ action: 'ranking' })).toBeNull();
  });
});

describe('dispatchUiAck', () => {
  it('dispatches a shelfie:ui:ack CustomEvent with the payload', () => {
    const handler = vi.fn();
    window.addEventListener(UI_BUS_ACK_EVENT, handler);
    dispatchUiAck({ action: 'navigate', ok: true });
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: 'navigate', ok: true });
    window.removeEventListener(UI_BUS_ACK_EVENT, handler);
  });
});
