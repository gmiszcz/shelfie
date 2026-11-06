import './StarFilter.css';
import { scoreBoundsForStars } from '../ranking';

export interface ScoreBounds {
  minScore: number;
  maxScore: number;
}

export interface StarFilterProps {
  /** The selected star bucket (0.5..5.0 in half steps), or null for "any". */
  value: number | null;
  /**
   * Called when the bucket changes. ``bounds`` is the matching `min_score`/`max_score` per rating
   * contract 1 (``display_score > bounds.minScore`` and ``<= bounds.maxScore``), or null for "any".
   */
  onChange: (stars: number | null, bounds: ScoreBounds | null) => void;
  /** Accessible label for the control (default "Filter by star band"). */
  ariaLabel?: string;
}

// Buckets 5.0 down to 0.5 in half steps.
const BUCKETS: number[] = Array.from({ length: 10 }, (_, i) => (10 - i) * 0.5);

/**
 * Pick a half-star bucket to filter by. Each bucket maps to a score band on the display scale:
 * "5 stars" shows books scored 4.6..5.0, "4.5 stars" shows 4.1..4.5, and so on. Selecting the
 * active bucket again clears the filter.
 */
export function StarFilter({ value, onChange, ariaLabel = 'Filter by star band' }: StarFilterProps) {
  const select = (stars: number | null): void => {
    if (stars == null) {
      onChange(null, null);
      return;
    }
    onChange(stars, scoreBoundsForStars(stars));
  };

  return (
    <div className="star-filter" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={`star-filter-chip${value == null ? ' is-active' : ''}`}
        aria-pressed={value == null}
        onClick={() => select(null)}
      >
        Any
      </button>
      {BUCKETS.map((stars) => {
        const active = value != null && Math.abs(value - stars) < 1e-9;
        const label = Number.isInteger(stars) ? `${stars}` : `${stars}`;
        return (
          <button
            type="button"
            key={stars}
            className={`star-filter-chip${active ? ' is-active' : ''}`}
            aria-pressed={active}
            aria-label={`${label} star${stars === 1 ? '' : 's'}`}
            onClick={() => select(active ? null : stars)}
          >
            <span className="star-filter-value">{label}</span>
            <i className="pi pi-star-fill" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
