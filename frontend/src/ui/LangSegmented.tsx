import type { SeriesSearchLang } from '../types';

import './LangSegmented.css';

export interface LangSegmentedProps {
  value: SeriesSearchLang;
  onChange: (next: SeriesSearchLang) => void;
  /** Accessible label for the group (e.g. "Search language for The Wandering Inn"). */
  ariaLabel: string;
  /** Disable the control (e.g. while a save is in flight). */
  disabled?: boolean;
  className?: string;
}

const OPTIONS: { id: SeriesSearchLang; label: string }[] = [
  { id: 'pl', label: 'PL' },
  { id: 'en', label: 'EN' },
  { id: 'both', label: 'Both' },
];

/**
 * LangSegmented — a compact PL | EN | Both segmented control for choosing the
 * release-research language. One row, touch targets >= 44px, spacing from :root
 * tokens. Used next to the Watch toggle on the series card and in Settings.
 */
export function LangSegmented({
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: LangSegmentedProps) {
  return (
    <div
      className={['ui-lang-seg', className ?? ''].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {OPTIONS.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`ui-lang-seg-btn ${active ? 'ui-lang-seg-btn--active' : ''}`}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
