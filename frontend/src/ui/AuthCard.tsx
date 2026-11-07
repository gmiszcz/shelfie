import type { ReactNode } from 'react';

import './AuthCard.css';

export interface AuthCardProps {
  /** Large heading (the page's single focal line). */
  title: ReactNode;
  /** Supporting line under the title. */
  subtitle?: ReactNode;
  /** Form / body content. */
  children: ReactNode;
  /** Quiet content below the card (links, hints). */
  footer?: ReactNode;
}

/**
 * AuthCard — the centered single-panel frame the login and setup screens share.
 * One white Panel on the light dashboard surface, brand mark above it, optional
 * quiet footer below. Reused rather than duplicated across auth screens.
 */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div className="ui-authscreen">
      <div className="ui-authscreen-inner">
        <div className="ui-authscreen-brand">
          <i className="pi pi-book" aria-hidden="true" />
          <span>Shelfie</span>
        </div>
        <section className="ui-authcard">
          <header className="ui-authcard-head">
            <h1 className="ui-authcard-title">{title}</h1>
            {subtitle && <p className="ui-authcard-subtitle">{subtitle}</p>}
          </header>
          {children}
        </section>
        {footer && <div className="ui-authscreen-footer">{footer}</div>}
      </div>
    </div>
  );
}
