import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FavouriteToggle } from './FavouriteToggle';

describe('FavouriteToggle', () => {
  it('exposes an accessible pressed state reflecting the value', () => {
    const { rerender } = render(<FavouriteToggle value={false} onChange={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Add to favourites' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    rerender(<FavouriteToggle value onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Remove from favourites' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('toggles to the opposite value on click', () => {
    const onChange = vi.fn();
    render(<FavouriteToggle value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not bubble the click to a parent (so the card dialog never opens)', () => {
    const parentClick = vi.fn();
    const onChange = vi.fn();
    render(
      <div onClick={parentClick}>
        <FavouriteToggle value={false} onChange={onChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
