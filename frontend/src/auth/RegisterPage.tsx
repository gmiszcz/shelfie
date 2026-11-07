import { Button } from 'primereact/button';
import { useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import { AuthCard, AuthField, AuthMessage } from '../ui';
import { useAuth } from './AuthProvider';
import { MIN_PASSWORD } from './authTypes';

interface RegisterPageProps {
  /** Go back to the login screen. */
  onLogin: () => void;
}

/**
 * RegisterPage — create an account: name, e-mail, password + repeat. The new
 * account is a normal user with an empty library and is logged in at once.
 */
export function RegisterPage({ onLogin }: RegisterPageProps) {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && password !== repeat;
  const canSubmit =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= MIN_PASSWORD &&
    password === repeat &&
    !submitting;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await register(email.trim(), name.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('An account with this e-mail already exists. Log in instead.');
      } else if (err instanceof ApiError && err.status === 422) {
        setError(`Check the e-mail and use a password of at least ${MIN_PASSWORD} characters.`);
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Creating accounts is turned off. Ask the admin.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Try again in a few minutes.');
      } else {
        setError('Could not create the account. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Create account"
      subtitle="Your own library. It starts empty."
      footer={
        <span>
          Already have an account?{' '}
          <button type="button" className="ui-authlink" onClick={onLogin}>
            Log in
          </button>
        </span>
      }
    >
      <form className="ui-authform" onSubmit={onSubmit} noValidate>
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        <AuthField
          id="reg-name"
          label="Name"
          autoComplete="name"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AuthField
          id="reg-email"
          label="E-mail"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <AuthField
          id="reg-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          aria-invalid={tooShort}
          onChange={(e) => setPassword(e.target.value)}
          hint={
            tooShort ? `Use at least ${MIN_PASSWORD} characters.` : `At least ${MIN_PASSWORD} characters.`
          }
        />
        <AuthField
          id="reg-repeat"
          label="Repeat password"
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          aria-invalid={mismatch}
          onChange={(e) => setRepeat(e.target.value)}
          hint={mismatch ? 'The two passwords do not match.' : undefined}
        />
        <Button
          type="submit"
          className="ui-authsubmit"
          label={submitting ? 'Creating…' : 'Create account'}
          loading={submitting}
          disabled={!canSubmit}
        />
      </form>
    </AuthCard>
  );
}
