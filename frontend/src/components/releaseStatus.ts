import type { ReleaseStatus } from '../types';

/** PrimeIcons class + human label for each release status, used on the series card. */
export interface ReleaseStatusVisual {
  /** PrimeIcons class, e.g. 'pi pi-check-circle'. */
  icon: string;
  /** Short English label shown next to the icon. */
  label: string;
  /** Pill tone echoing the design-system accent for this status. */
  tone: 'green' | 'blue' | 'violet' | 'grey';
}

/**
 * Maps a release status to its status icon, label and tone. The `checking`
 * (research in flight) state is handled separately on the card with a spinner;
 * every stored status maps here, with an unknown/missing value falling back to
 * the question mark.
 */
export const RELEASE_STATUS_VISUALS: Record<ReleaseStatus, ReleaseStatusVisual> = {
  released: { icon: 'pi pi-check-circle', label: 'Released', tone: 'green' },
  announced: { icon: 'pi pi-calendar', label: 'Announced', tone: 'blue' },
  in_translation: { icon: 'pi pi-language', label: 'In translation', tone: 'violet' },
  no_news: { icon: 'pi pi-minus-circle', label: 'No news', tone: 'grey' },
  unknown: { icon: 'pi pi-question-circle', label: 'Unknown', tone: 'grey' },
};

/** Resolve a status (possibly an unexpected string) to its visual, defaulting to unknown. */
export function releaseStatusVisual(status: string | null | undefined): ReleaseStatusVisual {
  if (status && status in RELEASE_STATUS_VISUALS) {
    return RELEASE_STATUS_VISUALS[status as ReleaseStatus];
  }
  return RELEASE_STATUS_VISUALS.unknown;
}
