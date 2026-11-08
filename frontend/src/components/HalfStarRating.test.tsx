import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HalfStarRating } from './HalfStarRating';

afterEach(cleanup);

describe('HalfStarRating', () => {
  it('reports half-star values when the left half of a star is clicked', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={null} onChange={onChange} />);
    // Left half of the 4th star => 3.5.
    fireEvent.click(screen.getByLabelText('Rate 3.5 stars'));
    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('reports whole-star values when the right half is clicked', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Rate 4 stars'));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('increments and decrements by 0.5 with arrow keys', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={3} onChange={onChange} ariaLabel="Rating" />);
    const slider = screen.getByRole('slider', { name: 'Rating' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
  });

  it('clears to null from the bottom with ArrowLeft', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={0.5} onChange={onChange} ariaLabel="Rating" />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rating' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('clamps at the maximum', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={5} onChange={onChange} ariaLabel="Rating" />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rating' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it('exposes a clear button that resets to null', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={4} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Clear rating'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('is not interactive when readOnly', () => {
    const onChange = vi.fn();
    render(<HalfStarRating value={4} onChange={onChange} readOnly ariaLabel="Rating" />);
    expect(screen.queryByLabelText('Clear rating')).toBeNull();
    expect(screen.queryByLabelText('Rate 4 stars')).toBeNull();
    const slider = screen.getByRole('slider', { name: 'Rating' });
    expect(slider.getAttribute('aria-valuenow')).toBe('4');
  });
});
