import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StarFilter } from './StarFilter';

afterEach(cleanup);

describe('StarFilter', () => {
  it('emits the score bounds for a 5-star bucket (contract: >4.5, <=5.0)', () => {
    const onChange = vi.fn();
    render(<StarFilter value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('5 stars'));
    expect(onChange).toHaveBeenCalledWith(5, { minScore: 4.5, maxScore: 5 });
  });

  it('emits bounds for a 4.5-star bucket', () => {
    const onChange = vi.fn();
    render(<StarFilter value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('4.5 stars'));
    expect(onChange).toHaveBeenCalledWith(4.5, { minScore: 4, maxScore: 4.5 });
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

  it('marks the active bucket pressed', () => {
    render(<StarFilter value={3} onChange={() => {}} />);
    expect(screen.getByLabelText('3 stars').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('5 stars').getAttribute('aria-pressed')).toBe('false');
  });
});
