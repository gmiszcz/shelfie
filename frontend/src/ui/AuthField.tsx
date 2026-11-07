import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface AuthFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Field label text. */
  label: ReactNode;
  /** Stable id (label htmlFor + input id). */
  id: string;
  /** Per-field hint shown under the input (e.g. password rules). */
  hint?: ReactNode;
}

/**
 * AuthField — a labeled text/password input used on the auth screens. Native
 * input styled to the dashboard look; the label is a real <label> for the input.
 * Reused by LoginPage, SetupPasswordPage and the change-password dialog.
 */
export const AuthField = forwardRef<HTMLInputElement, AuthFieldProps>(function AuthField(
  { label, id, hint, className, ...inputProps },
  ref,
) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="ui-authfield">
      <label htmlFor={id} className="ui-authfield-label">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        className={['ui-authfield-input', className ?? ''].filter(Boolean).join(' ')}
        aria-describedby={hintId}
        {...inputProps}
      />
      {hint && (
        <p id={hintId} className="ui-authfield-hint">
          {hint}
        </p>
      )}
    </div>
  );
});
