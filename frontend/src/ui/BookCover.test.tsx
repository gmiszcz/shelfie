import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BookCover } from './BookCover';
import { StatusTag } from './StatusTag';

describe('BookCover', () => {
  it('renders the image with alt text when a cover exists', () => {
    const { getByAltText } = render(<BookCover src="/api/covers/a.jpg" title="Dune" />);
    expect(getByAltText('Cover of Dune').getAttribute('src')).toBe('/api/covers/a.jpg');
  });

  it('renders a poster-shaped placeholder when there is no cover', () => {
    const { container } = render(<BookCover src={null} title="Dune" size="detail" />);
    const box = container.querySelector('.ui-cover');
    expect(box?.classList.contains('ui-cover--detail')).toBe(true);
    expect(container.querySelector('.ui-cover-placeholder')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('StatusTag', () => {
  it('shows the label for the status', () => {
    const { getByText } = render(<StatusTag status="finished" />);
    expect(getByText('Finished')).toBeTruthy();
  });
});
