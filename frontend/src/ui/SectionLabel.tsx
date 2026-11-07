import type { ReactNode } from 'react';

/**
 * SectionLabel — the small, muted, letter-spaced monospace label that sits above a
 * section or a stat (e.g. `TODAY · 24H RECAP`, `SIGNALS`). The text is rendered as
 * given; callers pass it already upper- or title-cased and CSS applies the uppercase
 * transform and tracking, so the look is consistent everywhere.
 */
export interface SectionLabelProps {
  children: ReactNode;
  /** Optional PrimeReact icon class (e.g. `pi pi-chart-bar`) shown before the text. */
  icon?: string;
  /** Renders as this element (default `div`). Use `span` inline. */
  as?: 'div' | 'span' | 'h2' | 'h3' | 'h4';
  className?: string;
  id?: string;
}

export function SectionLabel({
  children,
  icon,
  as: Tag = 'div',
  className,
  id,
}: SectionLabelProps) {
  return (
    <Tag className={['ui-section-label', className ?? ''].filter(Boolean).join(' ')} id={id}>
      {icon && <i className={icon} aria-hidden="true" />}
      {children}
    </Tag>
  );
}
