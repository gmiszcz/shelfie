import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MicButton } from './MicButton';

/**
 * MicButton is a thin shell over the useVoiceInput hook. These tests cover the
 * visual states the user reported missing: the in-flight loading ring (shown
 * while a chat request is busy) and the recording red state. The hook's audio
 * side is not exercised here (see useVoiceInput.test.ts) — getUserMedia is only
 * called on click, so an idle render needs no audio stubs.
 */

beforeEach(() => {
  // A no-op matchMedia so the hook's reduced-motion probe does not throw.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.matchMedia = globalThis.matchMedia;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MicButton visual states', () => {
  it('shows the circular in-flight ring and disables the mic when busy', () => {
    // ChatWidget passes both disabled and busy while a chat request is in flight.
    const { container } = render(
      <MicButton onFinal={vi.fn()} language="pl-PL" disabled busy />,
    );
    const button = container.querySelector('.mic-button');
    expect(button).not.toBeNull();
    expect(button?.classList.contains('busy')).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    // The loading ring element is a circular overlay AROUND the button.
    expect(container.querySelector('.mic-progress')).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders no in-flight ring when idle', () => {
    const { container } = render(<MicButton onFinal={vi.fn()} language="pl-PL" />);
    expect(container.querySelector('.mic-progress')).toBeNull();
    const button = container.querySelector('.mic-button');
    expect(button?.classList.contains('recording')).toBe(false);
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});
