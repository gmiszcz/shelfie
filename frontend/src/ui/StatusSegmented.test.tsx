import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusSegmented } from './StatusSegmented';

afterEach(cleanup);

describe('StatusSegmented', () => {
  it('shows four one-tap options with the current one checked', () => {
    render(<StatusSegmented value="finished" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: /Finished/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Want/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('one tap changes the status; tapping the current one does nothing', () => {
    const onChange = vi.fn();
    render(<StatusSegmented value="finished" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Reading/ }));
    expect(onChange).toHaveBeenCalledWith('reading');
    fireEvent.click(screen.getByRole('radio', { name: /Finished/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
