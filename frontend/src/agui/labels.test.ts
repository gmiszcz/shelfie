import { describe, expect, it } from 'vitest';

import { describeAction } from './labels';

describe('describeAction', () => {
  it('labels describe_ui and get_state', () => {
    expect(describeAction('describe_ui', {})).toBe('Read the interface');
    expect(describeAction('get_state', { id: 'library.search' })).toBe('Read library search');
  });

  it('labels set with an id and value', () => {
    expect(describeAction('set', { id: 'library.search', value: 'dune' })).toBe(
      'Set library search → dune',
    );
    expect(describeAction('set', { id: 'settings.cardFields.author', value: true })).toBe(
      'Set settings cardFields author → on',
    );
    expect(describeAction('set', { id: 'library.starFilter', value: '' })).toBe(
      'Set library starFilter',
    );
  });

  it('labels invoke with an action and id', () => {
    expect(describeAction('invoke', { id: 'library.books', action: 'open' })).toBe(
      'open library books',
    );
    expect(describeAction('invoke', { id: 'settings.sidebar' })).toBe('Invoke settings sidebar');
  });

  it('labels navigate and find_books', () => {
    expect(describeAction('navigate', { tab: 'ranking' })).toBe('Go to ranking');
    expect(describeAction('find_books', { query: 'Herbert' })).toBe('Find books "Herbert"');
  });

  it('falls back to the tool name for an unknown tool', () => {
    expect(describeAction('mystery', {})).toBe('mystery');
  });
});
