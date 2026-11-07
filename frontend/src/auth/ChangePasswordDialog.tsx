import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import { AuthField, AuthMessage } from '../ui';
import { useAuth } from './AuthProvider';

const MIN_PASSWORD = 10;

interface ChangePasswordDialogProps {
  visible: boolean;
  onHide: () => void;
}

/**
 * ChangePasswordDialog — current password, new password, repeat. On success the
 * server revokes this user's other sessions; the dialog closes with a note. Min
 * 10 characters; new-password autocomplete so a manager can store the change.
 */
export function ChangePasswordDialog({ visible, onHide }: ChangePasswordDialogProps) {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset fields whenever the dialog opens.
  useEffect(() => {
    if (visible) {
      setCurrent('');
      setNext('');
      setRepeat('');
      setError(null);
      setDone(false);
      setSubmitting(false);
    }
  }, [visible]);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && next !== repeat;
  const canSubmit =
    current.length > 0 &&
    next.length >= MIN_PASSWORD &&
    next === repeat &&
    !submitting &&
    !done;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('Your current password is incorrect.');
      } else if (err instanceof ApiError && err.status === 422) {
        setError(`The new password must be at least ${MIN_PASSWORD} characters.`);
      } else {
        setError('Could not change your password. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      header="Change password"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: '26rem' }}
      breakpoints={{ '640px': '100vw' }}
    >
      <form className="ui-authform" onSubmit={onSubmit} noValidate>
        {done ? (
          <AuthMessage tone="info">
            Password changed. Your other sessions have been signed out.
          </AuthMessage>
        ) : (
          <>
            {error && <AuthMessage tone="error">{error}</AuthMessage>}
            <AuthField
              id="cp-current"
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <AuthField
              id="cp-new"
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              value={next}
              aria-invalid={tooShort}
              onChange={(e) => setNext(e.target.value)}
              hint={
                tooShort
                  ? `Use at least ${MIN_PASSWORD} characters.`
                  : `At least ${MIN_PASSWORD} characters.`
              }
            />
            <AuthField
              id="cp-repeat"
              label="Repeat new password"
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              aria-invalid={mismatch}
              onChange={(e) => setRepeat(e.target.value)}
              hint={mismatch ? 'The two passwords do not match.' : undefined}
            />
          </>
        )}
        <div className="ui-authdialog-actions">
          {done ? (
            <Button type="button" label="Done" onClick={onHide} />
          ) : (
            <>
              <Button type="button" label="Cancel" text onClick={onHide} disabled={submitting} />
              <Button
                type="submit"
                label={submitting ? 'Changing…' : 'Change password'}
                loading={submitting}
                disabled={!canSubmit}
              />
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
}
