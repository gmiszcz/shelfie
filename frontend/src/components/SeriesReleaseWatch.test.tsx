import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SeriesReleaseWatch } from './SeriesReleaseWatch';
import { RELEASE_STATUS_VISUALS, releaseStatusVisual } from './releaseStatus';
import type { ReleaseStatus, ReleaseSummary } from '../types';

function summary(overrides: Partial<ReleaseSummary> = {}): ReleaseSummary {
  return {
    status: 'announced',
    headline: 'Fabryka Słów nie podała oficjalnej daty tomu 7.',
    next_title: 'Ritual of Ruin',
    next_volume: 7,
    expected_date: '2026',
    details: [{ text: 'Tłumaczenie ruszyło na początku 2026.', source_url: 'https://ex.com/a' }],
    editions: {
      pl: { status: 'in_translation', title: 'Rytuał Ruin', date: null, source_url: 'https://ex.com/pl' },
      en: { status: 'released', title: 'Ritual of Ruin', date: '2025-11-11', source_url: 'https://ex.com/en' },
    },
    added_book_id: null,
    checked_at: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

afterEach(cleanup);

describe('releaseStatusVisual mapping', () => {
  it('maps each known status to an icon + label', () => {
    const cases: Record<ReleaseStatus, string> = {
      released: 'pi pi-check-circle',
      announced: 'pi pi-calendar',
      in_translation: 'pi pi-language',
      no_news: 'pi pi-minus-circle',
      unknown: 'pi pi-question-circle',
    };
    for (const [status, icon] of Object.entries(cases)) {
      expect(RELEASE_STATUS_VISUALS[status as ReleaseStatus].icon).toBe(icon);
    }
  });

  it('falls back to unknown for a missing or unexpected status', () => {
    expect(releaseStatusVisual(null).icon).toBe('pi pi-question-circle');
    expect(releaseStatusVisual('nonsense').icon).toBe('pi pi-question-circle');
  });
});

describe('SeriesReleaseWatch', () => {
  const noop = vi.fn();

  it('shows the status label and the single headline sentence', () => {
    render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={summary()}
        checking={false}
        onOpenBook={noop}
      />,
    );
    expect(screen.getByText('Announced')).toBeTruthy();
    expect(screen.getByText('Fabryka Słów nie podała oficjalnej daty tomu 7.')).toBeTruthy();
  });

  it('shows the correct status icon for a released summary', () => {
    const { container } = render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={summary({ status: 'released' })}
        checking={false}
        onOpenBook={noop}
      />,
    );
    expect(container.querySelector('.series-release-icon.pi-check-circle')).toBeTruthy();
  });

  it('hides details until the toggle is clicked, then reveals editions and bullets', () => {
    render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={summary()}
        checking={false}
        onOpenBook={noop}
      />,
    );
    // Collapsed: the bullet text is not rendered.
    expect(screen.queryByText('Tłumaczenie ruszyło na początku 2026.')).toBeNull();
    const toggle = screen.getByRole('button', { name: /details/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Tłumaczenie ruszyło na początku 2026.')).toBeTruthy();
    // Per-edition rows are present.
    expect(screen.getByText('PL')).toBeTruthy();
    expect(screen.getByText('EN')).toBeTruthy();
  });

  it('opens the added book when the "added to library" badge is clicked', () => {
    const onOpenBook = vi.fn();
    render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={summary({ added_book_id: 312 })}
        checking={false}
        onOpenBook={onOpenBook}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    fireEvent.click(screen.getByText('Added to library'));
    expect(onOpenBook).toHaveBeenCalledWith(312);
  });

  it('falls back to "Not checked yet" when there is no summary', () => {
    render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={null}
        checking={false}
        onOpenBook={noop}
      />,
    );
    expect(screen.getByText('Not checked yet')).toBeTruthy();
  });

  it('shows a checking spinner when research is in flight', () => {
    render(
      <SeriesReleaseWatch
        seriesKey="k"
        seriesName="Series"
        summary={null}
        checking={true}
        onOpenBook={noop}
      />,
    );
    expect(screen.getByText('Checking new volumes…')).toBeTruthy();
  });
});
