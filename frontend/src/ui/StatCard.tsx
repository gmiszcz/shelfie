import type { ReactNode } from 'react';

import { SectionLabel } from './SectionLabel';
import { Sparkline } from './Sparkline';

export type StatTone = 'default' | 'green' | 'muted';

/**
 * StatCard — the KPI unit from the reference: a small muted monospace label, a big bold
 * value, and an optional tiny sparkline of the trend underneath. Generic: give it a
 * label, a value (string or number), and optionally a `trend` series for the sparkline.
 *
 * It renders only the stat block (label + value + spark), NOT a surrounding box, so it
 * composes inside a Panel, a grid, or a sub-panel without nesting cards.
 */
export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Series for the inline sparkline. Omit or give <2 points to hide it. */
  trend?: number[];
  /** Value colour accent. */
  tone?: StatTone;
  /** Sparkline stroke colour; defaults to the themed accent. */
  sparkColor?: string;
  /** Small caption shown to the right of / under the value (e.g. a unit). */
  caption?: ReactNode;
  className?: string;
}

const VALUE_TONE: Record<StatTone, string> = {
  default: '',
  green: 'ui-statcard-value--green',
  muted: 'ui-statcard-value--muted',
};

export function StatCard({
  label,
  value,
  trend,
  tone = 'default',
  sparkColor,
  caption,
  className,
}: StatCardProps) {
  return (
    <div className={['ui-statcard', className ?? ''].filter(Boolean).join(' ')}>
      <SectionLabel>{label}</SectionLabel>
      <div className="ui-statcard-row">
        <span className={['ui-statcard-value', VALUE_TONE[tone]].filter(Boolean).join(' ')}>
          {value}
        </span>
        {caption && <span className="ui-statcard-caption">{caption}</span>}
      </div>
      {trend && trend.length >= 2 && (
        <Sparkline data={trend} color={sparkColor} className="ui-statcard-spark" />
      )}
    </div>
  );
}
