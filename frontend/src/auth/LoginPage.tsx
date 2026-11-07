import { Button } from 'primereact/button';
import { useRef, useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import { AuthCard, AuthField, AuthMessage } from '../ui';
import { useAuth } from './AuthProvider';

/** Turn a Retry-After in seconds into a short, human wait phrase. */
function waitPhrase(seconds: number): string {
  if (seconds <= 1) return 'a moment';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/**
 * LoginPage — e-mail + password. Inline error on failure, a dedicated throttle
 * message with the wait time on 429. Autocomplete attributes let the browser's
 * password manager fill the form.
 */
export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [throttled, setThrottled] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setThrottled(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setThrottled(err.retryAfter ?? 0);
      } else {
        // The server returns a generic message; never reveal whether the e-mail exists.
        setError('Invalid e-mail or password');
      }
      // Keep the e-mail, clear the password, focus back for a quick retry.
      setPassword('');
      emailRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Log in"
      subtitle="Sign in to your Shelfie library."
    >
      <form className="ui-authform" onSubmit={onSubmit} noValidate>
        {throttled !== null && (
          <AuthMessage tone="error">
            Too many attempts. Try again in {waitPhrase(throttled)}.
          </AuthMessage>
        )}
        {error && <AuthMessage tone="error">{error}</AuthMessage>}

        <AuthField
          ref={emailRef}
          id="login-email"
          label="E-mail"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          aria-invalid={Boolean(error)}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <AuthField
          id="login-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          aria-invalid={Boolean(error)}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          type="submit"
          className="ui-authsubmit"
          label={submitting ? 'Logging in…' : 'Log in'}
          loading={submitting}
          disabled={submitting || !email.trim() || !password}
        />
      </form>
    </AuthCard>
  );
}
