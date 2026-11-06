import './StarFilter.css';

export interface ScoreBounds {
  minScore: number;
  maxScore: number;
}

/** The whole-star buckets the filter offers. */
export type StarBucket = 1 | 2 | 3 | 4 | 5;

export const STAR_BUCKETS: StarBucket[] = [1, 2, 3, 4, 5];

/**
 * The score band a whole-star bucket owns, per the wave-3 star-filter rule.
 *
 * Bucket N matches books whose score (``display_score``, else ``stars``) is in
 * ``(N - 0.5, N + 0.5]`` — except the ends are clamped so every score maps to
 * exactly one bucket:
 *   - 5 -> ``(4.5, 5.0]``   (4.6..5.0)
 *   - 1 -> ``[0, 1.5]``     (0..1.5)
 *
 * The returned bounds are consumed by ``filterByScore`` as
 * ``minScore < score <= maxScore``. The lower end of bucket 1 is pushed below 0
 * so a score of exactly 0 is still included.
 */
export function boundsForStarBucket(stars: StarBucket): ScoreBounds {
  const minScore = stars === 1 ? -0.1 : stars - 0.5;
  const maxScore = stars === 5 ? 5.0 : stars + 0.5;
  return { minScore, maxScore };
}

export interface StarFilterProps {
  /** The selected whole-star bucket (1..5), or null for "Any". */
  value: StarBucket | null;
  /**
   * Called when the bucket changes. ``bounds`` is the matching score band
   * (``minScore < score <= maxScore``), or null for "Any".
   */
  onChange: (stars: StarBucket | null, bounds: ScoreBounds | null) => void;
  /** Accessible label for the control (default "Filter by rating"). */
  ariaLabel?: string;
}

/**
 * Compact whole-star rating filter: an "Any" chip plus one chip per whole star
 * (1..5), each rendered as that many filled star glyphs. It is an independent
 * control from the library search box; the two combine with AND.
 *
 * Selecting the active bucket again clears the filter.
 */
export function StarFilter({ value, onChange, ariaLabel = 'Filter by rating' }: StarFilterProps) {
  const select = (stars: StarBucket | null): void => {
    if (stars == null) {
      onChange(null, null);
      return;
    }
    onChange(stars, boundsForStarBucket(stars));
  };

  return (
    <div className="star-filter" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={`star-filter-chip star-filter-any${value == null ? ' is-active' : ''}`}
        aria-pressed={value == null}
        onClick={() => select(null)}
      >
        Any
      </button>
      {STAR_BUCKETS.map((stars) => {
        const active = value === stars;
        return (
          <button
            type="button"
            key={stars}
            className={`star-filter-chip${active ? ' is-active' : ''}`}
            aria-pressed={active}
            aria-label={`${stars} star${stars === 1 ? '' : 's'}`}
            title={`${stars} star${stars === 1 ? '' : 's'}`}
            onClick={() => select(active ? null : stars)}
          >
            {Array.from({ length: stars }, (_, i) => (
              <i key={i} className="pi pi-star-fill" aria-hidden="true" />
            ))}
          </button>
        );
      })}
    </div>
  );
}
