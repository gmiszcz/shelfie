import { Button } from 'primereact/button';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, api } from '../services/api';
import type { SetupTokenInfo } from './authTypes';
import { AuthCard, AuthField, AuthMessage } from '../ui';
import { useAuth } from './AuthProvider';
import { MIN_PASSWORD } from './authTypes';


type Phase = 'loading' | 'ready' | 'expired' | 'error';

interface SetupPasswordPageProps {
  /** The setup/reset token from /setup?token=... */
  token: string;
  /** Called once the password is set and the person is logged in. */
  onDone: () => void;
}

/**
 * SetupPasswordPage — resolves the token to show who the link is for, then takes
 * a new password + repeat (min MIN_PASSWORD = 8 chars). On success the person is logged in and
 * sent to the library. A 410 means the link expired or was already used.
 */
export function SetupPasswordPage({ token, onDone }: SetupPasswordPageProps) {
  const { setUser } = useAuth();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<SetupTokenInfo | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setPhase('error');
        return;
      }
      try {
        const resolved = await api.getSetupToken(token);
        if (!cancelled) {
          setInfo(resolved);
          setPhase('ready');
        }
      } catch (err) {
        if (cancelled) return;
        setPhase(err instanceof ApiError && err.status === 410 ? 'expired' : 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && password !== repeat;
  const canSubmit =
    password.length >= MIN_PASSWORD && repeat.length > 0 && password === repeat && !submitting;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) {
      passwordRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const user = await api.completeSetup(token, password);
      setUser(user);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setPhase('expired');
      } else {
        setError('Could not set your password. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === 'loading') {
    return (
      <AuthCard title="Set your password" subtitle="Checking your link…">
        <div className="ui-authform" aria-busy="true" />
      </AuthCard>
    );
  }

  if (phase === 'expired') {
    return (
      <AuthCard
        title="Link expired"
        subtitle="This setup link is no longer valid."
      >
        <AuthMessage tone="error">
          This link has expired or was already used. Ask the admin for a new one.
        </AuthMessage>
      </AuthCard>
    );
  }

  if (phase === 'error') {
    return (
      <AuthCard title="Set your password" subtitle="Something went wrong.">
        <AuthMessage tone="error">
          We couldn't open this link. Check it is complete, or ask the admin for a new one.
        </AuthMessage>
      </AuthCard>
    );
  }

  const isReset = info?.purpose === 'reset';
  return (
    <AuthCard
      title={isReset ? 'Reset your password' : 'Set your password'}
      subtitle={
        info ? (
          <>
            For <strong>{info.display_name}</strong> ({info.email}).
          </>
        ) : undefined
      }
    >
      <form className="ui-authform" onSubmit={onSubmit} noValidate>
        {error && <AuthMessage tone="error">{error}</AuthMessage>}

        <AuthField
          ref={passwordRef}
          id="setup-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          aria-invalid={touched && tooShort}
          onChange={(e) => setPassword(e.target.value)}
          hint={
            tooShort
              ? `Use at least ${MIN_PASSWORD} characters.`
              : `At least ${MIN_PASSWORD} characters.`
          }
        />
        <AuthField
          id="setup-repeat"
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
          label={submitting ? 'Setting password…' : 'Set password and log in'}
          loading={submitting}
          disabled={!canSubmit}
        />
      </form>
    </AuthCard>
  );
}
