import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('sets aria values and renders the label', () => {
    render(<ProgressBar value={3} max={7} label="3 of 7 read" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('7');
    expect(screen.getByText('3 of 7 read')).toBeTruthy();
  });

  it('clamps the fill width to 100% and handles max=0 safely', () => {
    const { container, rerender } = render(<ProgressBar value={9} max={5} label="over" />);
    const fill = container.querySelector('.ui-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');

    rerender(<ProgressBar value={0} max={0} label="none" />);
    const fill2 = container.querySelector('.ui-progress-fill') as HTMLElement;
    expect(fill2.style.width).toBe('0%');
  });
});
