import type { ReactNode } from 'react';

import { SectionLabel } from './SectionLabel';

export type PanelTint = 'none' | 'green' | 'blue' | 'orange' | 'violet' | 'feature';

/**
 * Panel — the large surface card the whole UI is built from: white (or dark feature),
 * soft 1px border, generous radius and padding, one authored shadow. Nested content
 * can use a tinted sub-panel via `tint`.
 *
 * When `label` is set, a monospace SectionLabel is rendered as the panel's heading,
 * optionally with `icon`. Pass `flush` for edge-to-edge content (e.g. a table) that
 * owns its own padding.
 *
 * Kept generic so new tabs (Series, Favourites, …) can adopt it directly.
 */
export interface PanelProps {
  children: ReactNode;
  /** Monospace section label shown as the panel heading. */
  label?: ReactNode;
  /** Optional PrimeReact icon class for the label. */
  icon?: string;
  /** Right-aligned content on the header row (counts, controls). */
  actions?: ReactNode;
  /** Soft background tint; `feature` is the dark callout panel. */
  tint?: PanelTint;
  /** Remove padding so the child owns it (tables, media). */
  flush?: boolean;
  className?: string;
  as?: 'section' | 'div' | 'article';
}

const TINT_CLASS: Record<PanelTint, string> = {
  none: '',
  green: 'ui-subpanel--tint-green',
  blue: 'ui-subpanel--tint-blue',
  orange: 'ui-subpanel--tint-orange',
  violet: 'ui-subpanel--tint-violet',
  feature: 'ui-panel--feature',
};

export function Panel({
  children,
  label,
  icon,
  actions,
  tint = 'none',
  flush = false,
  className,
  as: Tag = 'section',
}: PanelProps) {
  const classes = [
    'ui-panel',
    flush ? 'ui-panel--flush' : '',
    TINT_CLASS[tint],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={classes}>
      {(label || actions) && (
        <header className="ui-panel-head">
          {label ? (
            <SectionLabel icon={icon}>{label}</SectionLabel>
          ) : (
            <span />
          )}
          {actions && <div className="ui-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}
