import './FilterBar.css';

export interface FilterOption<T extends string> {
  id: T;
  label: string;
  /** Optional count shown as a small chip after the label. */
  count?: number;
}

export interface FilterBarProps<T extends string> {
  options: FilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible label for the group (e.g. "Filter series"). */
  ariaLabel: string;
  className?: string;
}

/**
 * FilterBar — a compact segmented control of filter pills, each with an optional count.
 * One row; on narrow screens it scrolls horizontally rather than wrapping, mirroring the
 * compact segmented controls on the Stats tab. Spacing comes from the :root tokens and
 * siblings are spaced by `gap`, never margins.
 */
export function FilterBar<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: FilterBarProps<T>) {
  return (
    <div
      className={['ui-filterbar', className ?? ''].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ui-filterbar-pill ${active ? 'ui-filterbar-pill--active' : ''}`}
            onClick={() => onChange(opt.id)}
          >
            <span className="ui-filterbar-label">{opt.label}</span>
            {opt.count != null && <span className="ui-filterbar-count">{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
