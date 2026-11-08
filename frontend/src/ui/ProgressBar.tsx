import './ProgressBar.css';

export interface ProgressBarProps {
  /** Number of completed units (e.g. read volumes). */
  value: number;
  /** Total units (e.g. known volumes). When 0, the bar renders empty. */
  max: number;
  /** Optional label shown above the track, e.g. "3 of 7 read". */
  label?: string;
  className?: string;
}

/**
 * A thin progress track used on series cards ("N of M read"). A labelled wrapper over a
 * plain div track so every series card shows progress the same way. Spacing from :root.
 */
export function ProgressBar({ value, max, label, className }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 0;
  const pct = safeMax > 0 ? Math.min(100, Math.round((value / safeMax) * 100)) : 0;
  const classes = ['ui-progress', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {label && <span className="ui-progress-label">{label}</span>}
      <div
        className="ui-progress-track"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-label={label ?? `${value} of ${safeMax}`}
      >
        <div className="ui-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
