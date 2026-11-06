import { useState } from 'react';

import './HalfStarRating.css';

export interface HalfStarRatingProps {
  /** Current value in 0.5 steps (0.5..5.0), or null when unrated. */
  value: number | null;
  /** Called with the new value in 0.5 steps, or null when cleared. */
  onChange: (value: number | null) => void;
  /** Render without interaction (display only). */
  readOnly?: boolean;
  /** Hide the clear button. */
  hideClear?: boolean;
  /** Accessible label for the whole control. */
  ariaLabel?: string;
  /** Max whole stars (default 5). */
  max?: number;
}

const STEP = 0.5;

/**
 * A star rating that accepts half stars by clicking the left or right half of a star.
 *
 * - Pointer: hovering previews the value; the left half of star *n* is ``n - 0.5``, the right half
 *   is ``n``.
 * - Keyboard: the control is a single focusable slider. Arrow Left/Down decrease by 0.5, Arrow
 *   Right/Up increase by 0.5, Home = 0.5, End = max, Backspace/Delete/0 clears.
 * - A clear button removes the rating (sets it to null) unless ``hideClear`` is set.
 */
export function HalfStarRating({
  value,
  onChange,
  readOnly = false,
  hideClear = false,
  ariaLabel = 'Star rating',
  max = 5,
}: HalfStarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;

  const clamp = (v: number): number => Math.max(STEP, Math.min(max, v));

  const commit = (v: number | null): void => {
    if (readOnly) {
      return;
    }
    onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (readOnly) {
      return;
    }
    const current = value ?? 0;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        commit(clamp(current + STEP));
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        if (current <= STEP) {
          commit(null);
        } else {
          commit(clamp(current - STEP));
        }
        break;
      case 'Home':
        e.preventDefault();
        commit(STEP);
        break;
      case 'End':
        e.preventDefault();
        commit(max);
        break;
      case 'Backspace':
      case 'Delete':
      case '0':
        e.preventDefault();
        commit(null);
        break;
    }
  };

  const stars = Array.from({ length: max }, (_, i) => i + 1);

  return (
    <span className="half-star" role="group" aria-label={ariaLabel}>
      <span
        className="half-star-stars"
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? 0}
        aria-valuetext={value == null ? 'No rating' : `${value} of ${max} stars`}
        aria-readonly={readOnly}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setHover(null)}
      >
        {stars.map((n) => {
          const full = shown >= n;
          const half = !full && shown >= n - 0.5;
          const icon = full ? 'pi-star-fill' : half ? 'pi-star-half-fill' : 'pi-star';
          return (
            <span className="half-star-star" key={n}>
              <i className={`pi ${icon}`} aria-hidden="true" />
              {!readOnly && (
                <>
                  <button
                    type="button"
                    className="half-star-hit half-star-hit-left"
                    aria-label={`Rate ${n - 0.5} star${n - 0.5 === 1 ? '' : 's'}`}
                    onMouseEnter={() => setHover(n - 0.5)}
                    onClick={() => commit(n - 0.5)}
                  />
                  <button
                    type="button"
                    className="half-star-hit half-star-hit-right"
                    aria-label={`Rate ${n} star${n === 1 ? '' : 's'}`}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => commit(n)}
                  />
                </>
              )}
            </span>
          );
        })}
      </span>
      {!readOnly && !hideClear && value != null && (
        <button
          type="button"
          className="half-star-clear"
          aria-label="Clear rating"
          title="Clear rating"
          onClick={() => commit(null)}
        >
          <i className="pi pi-times" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
