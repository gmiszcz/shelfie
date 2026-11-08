import type { ReactNode } from 'react';

export type PillTone = 'grey' | 'green' | 'orange' | 'red' | 'blue' | 'violet';

/**
 * Pill — a soft-tinted status chip (e.g. `filled`, `skipped`). One tone per category,
 * used consistently: green = good/positive, orange = caution, red = bad/blocked,
 * blue = info, violet = secondary, grey = neutral/muted. An optional leading dot echoes
 * the reference list rows.
 */
export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  /** Show a small filled dot before the label. */
  dot?: boolean;
  className?: string;
}

export function Pill({ children, tone = 'grey', dot = false, className }: PillProps) {
  return (
    <span className={['ui-pill', `ui-pill--${tone}`, className ?? ''].filter(Boolean).join(' ')}>
      {dot && <span className="ui-pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
