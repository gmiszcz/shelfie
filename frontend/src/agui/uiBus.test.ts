import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiBusDetail } from '../types';
import { UI_BUS_EVENT } from '../types';
import { describeUiAction, dispatchUiAction, isUiTool, toUiBusDetail } from './uiBus';

describe('isUiTool', () => {
  it('recognizes the four UI tools and nothing else', () => {
    expect(isUiTool('filter_library')).toBe(true);
    expect(isUiTool('clear_filter')).toBe(true);
    expect(isUiTool('navigate')).toBe(true);
    expect(isUiTool('open_book')).toBe(true);
    expect(isUiTool('search_library')).toBe(false);
  });
});

describe('toUiBusDetail', () => {
  it('builds a filter_library detail with only the set facets', () => {
    expect(toUiBusDetail('filter_library', { series: 'Droga Szamana', query: '' })).toEqual({
      action: 'filter_library',
      series: 'Droga Szamana',
    });
  });

  it('keeps a positive min_stars and drops zero', () => {
    expect(toUiBusDetail('filter_library', { min_stars: 4.5 })).toEqual({
      action: 'filter_library',
      min_stars: 4.5,
    });
    expect(toUiBusDetail('filter_library', { min_stars: 0 })).toEqual({ action: 'filter_library' });
  });

  it('maps navigate with a valid tab and rejects an invalid one', () => {
    expect(toUiBusDetail('navigate', { tab: 'stats' })).toEqual({ action: 'navigate', tab: 'stats' });
    expect(toUiBusDetail('navigate', { tab: 'nope' })).toBeNull();
  });

  it('maps open_book and clear_filter', () => {
    expect(toUiBusDetail('open_book', { book_id: 7 })).toEqual({ action: 'open_book', book_id: 7 });
    expect(toUiBusDetail('open_book', {})).toBeNull();
    expect(toUiBusDetail('clear_filter', {})).toEqual({ action: 'clear_filter' });
  });

  it('returns null for an unknown tool', () => {
    expect(toUiBusDetail('search_library', { query: 'x' })).toBeNull();
  });
});

describe('describeUiAction', () => {
  it('describes a series filter', () => {
    const detail: UiBusDetail = { action: 'filter_library', series: 'Droga Szamana' };
    expect(describeUiAction(detail)).toBe('filtered library by series Droga Szamana');
  });

  it('describes navigation, open and clear', () => {
    expect(describeUiAction({ action: 'navigate', tab: 'ranking' })).toBe(
      'switched to the ranking tab',
    );
    expect(describeUiAction({ action: 'open_book', book_id: 3 })).toBe('opened book #3');
    expect(describeUiAction({ action: 'clear_filter' })).toBe('cleared the library filter');
  });
});

describe('dispatchUiAction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatches a shelfie:ui CustomEvent with the detail', () => {
    const spy = vi.fn();
    window.addEventListener(UI_BUS_EVENT, spy as EventListener);
    const detail = dispatchUiAction('filter_library', { series: 'Droga Szamana' });
    window.removeEventListener(UI_BUS_EVENT, spy as EventListener);

    expect(detail).toEqual({ action: 'filter_library', series: 'Droga Szamana' });
    expect(spy).toHaveBeenCalledTimes(1);
    const ev = spy.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toEqual({ action: 'filter_library', series: 'Droga Szamana' });
  });

  it('does not dispatch for an unusable call', () => {
    const spy = vi.fn();
    window.addEventListener(UI_BUS_EVENT, spy as EventListener);
    const detail = dispatchUiAction('navigate', { tab: 'bogus' });
    window.removeEventListener(UI_BUS_EVENT, spy as EventListener);

    expect(detail).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
