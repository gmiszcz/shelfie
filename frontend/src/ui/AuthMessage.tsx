import type { ReactNode } from 'react';

export interface AuthMessageProps {
  tone: 'error' | 'info';
  children: ReactNode;
}

/**
 * AuthMessage — the inline form-level notice used on the auth screens (invalid
 * credentials, throttle wait, expired link, password mismatch). Soft-tinted
 * block with a leading icon; `role="alert"` for errors so assistive tech
 * announces them. Shared across login, setup and the password dialog.
 */
export function AuthMessage({ tone, children }: AuthMessageProps) {
  const icon = tone === 'error' ? 'pi pi-exclamation-circle' : 'pi pi-info-circle';
  return (
    <div
      className={`ui-authmsg ui-authmsg--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <i className={icon} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
