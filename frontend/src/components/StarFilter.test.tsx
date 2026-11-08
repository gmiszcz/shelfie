import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StarFilter, boundsForStarBucket } from './StarFilter';

afterEach(cleanup);

describe('boundsForStarBucket', () => {
  it('5 -> (4.5, 5.0]', () => {
    expect(boundsForStarBucket(5)).toEqual({ minScore: 4.5, maxScore: 5.0 });
  });

  it('4 -> (3.5, 4.5]', () => {
    expect(boundsForStarBucket(4)).toEqual({ minScore: 3.5, maxScore: 4.5 });
  });

  it('3 -> (2.5, 3.5]', () => {
    expect(boundsForStarBucket(3)).toEqual({ minScore: 2.5, maxScore: 3.5 });
  });

  it('2 -> (1.5, 2.5]', () => {
    expect(boundsForStarBucket(2)).toEqual({ minScore: 1.5, maxScore: 2.5 });
  });

  it('1 -> [0, 1.5] (lower bound pushed below 0 to include a 0 score)', () => {
    expect(boundsForStarBucket(1)).toEqual({ minScore: -0.1, maxScore: 1.5 });
  });
});

describe('StarFilter', () => {
  it('offers Any + exactly five whole-star buckets', () => {
    render(<StarFilter value={null} onChange={() => {}} />);
    expect(screen.getByText('Any')).toBeTruthy();
    for (let n = 1; n <= 5; n++) {
      expect(screen.getByLabelText(`${n} star${n === 1 ? '' : 's'}`)).toBeTruthy();
    }
    // no half-star buckets
    expect(screen.queryByLabelText('4.5 stars')).toBeNull();
    expect(screen.queryByLabelText('0.5 stars')).toBeNull();
  });

  it('renders each bucket chip with that many star glyphs', () => {
    render(<StarFilter value={null} onChange={() => {}} />);
    const three = screen.getByLabelText('3 stars');
    expect(three.querySelectorAll('.pi-star-fill').length).toBe(3);
    const five = screen.getByLabelText('5 stars');
    expect(five.querySelectorAll('.pi-star-fill').length).toBe(5);
  });

  it('emits the score bounds for a 5-star bucket', () => {
    const onChange = vi.fn();
    render(<StarFilter value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('5 stars'));
    expect(onChange).toHaveBeenCalledWith(5, { minScore: 4.5, maxScore: 5.0 });
  });

  it('emits the score bounds for a 4-star bucket', () => {
    const onChange = vi.fn();
    render(<StarFilter value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('4 stars'));
    expect(onChange).toHaveBeenCalledWith(4, { minScore: 3.5, maxScore: 4.5 });
  });

  it('clears the filter when "Any" is clicked', () => {
    const onChange = vi.fn();
    render(<StarFilter value={5} onChange={onChange} />);
    fireEvent.click(screen.getByText('Any'));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('deselecting the active bucket clears it', () => {
    const onChange = vi.fn();
    render(<StarFilter value={5} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('5 stars'));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('marks the active bucket pressed and others not', () => {
    render(<StarFilter value={3} onChange={() => {}} />);
    expect(screen.getByLabelText('3 stars').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('5 stars').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Any').getAttribute('aria-pressed')).toBe('false');
  });
});
