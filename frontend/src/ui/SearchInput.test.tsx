import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchInput } from './SearchInput';

describe('SearchInput', () => {
  it('reports typed text', () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} ariaLabel="Search library" />);
    fireEvent.change(screen.getByLabelText('Search library'), { target: { value: 'droga' } });
    expect(onChange).toHaveBeenCalledWith('droga');
  });

  it('shows a clear button only when there is text, and clears it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput value="" onChange={onChange} ariaLabel="s" />);
    expect(screen.queryByLabelText('Clear search')).toBeNull();
    rerender(<SearchInput value="cesar" onChange={onChange} ariaLabel="s" />);
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
