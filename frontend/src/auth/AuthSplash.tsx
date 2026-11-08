import './AuthSplash.css';

/**
 * Neutral splash shown while the auth gate resolves "who am I". Brand mark plus a
 * quiet pulse — no spinner costume, no copy that implies an error. Matches the
 * light dashboard surface.
 */
export function AuthSplash() {
  return (
    <div className="auth-splash" role="status" aria-live="polite" aria-label="Loading Shelfie">
      <div className="auth-splash-brand">
        <i className="pi pi-book" aria-hidden="true" />
        <span>Shelfie</span>
      </div>
      <div className="auth-splash-bar" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
