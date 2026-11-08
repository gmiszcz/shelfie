import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FavouriteToggle } from './FavouriteToggle';

afterEach(cleanup);

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
    fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('always shows exactly ONE heart, however fast it is clicked (animation restarts)', () => {
    function Live() {
      const [v, setV] = useState(false);
      return <FavouriteToggle value={v} onChange={setV} />;
    }
    const { container } = render(<Live />);
    const btn = container.querySelector('button')!;
    for (let i = 0; i < 7; i += 1) {
      fireEvent.click(btn);
    }
    expect(container.querySelectorAll('i.pi').length).toBe(1);
    expect(container.querySelectorAll('.ui-fav-burst').length).toBeLessThanOrEqual(1);
  });

  it('does not bubble the click to a parent (so the card dialog never opens)', () => {
    const parentClick = vi.fn();
    const onChange = vi.fn();
    render(
      <div onClick={parentClick}>
        <FavouriteToggle value={false} onChange={onChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
    expect(onChange).toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
