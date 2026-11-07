import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, api } from '../services/api';
import { AuthField, AuthMessage } from '../ui';
import type { CreatedUser } from './authTypes';
import { SetupLinkBox } from './SetupLinkBox';

interface AddPersonDialogProps {
  visible: boolean;
  onHide: () => void;
  /** Called after a person is created so the list can refresh. */
  onCreated: () => void;
}

/**
 * AddPersonDialog — the admin adds a person by name + e-mail; the server creates
 * an empty library and returns a one-time setup link, which the dialog shows with
 * a Copy button and expiry for the admin to pass along.
 */
export function AddPersonDialog({ visible, onHide, onCreated }: AddPersonDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setName('');
      setEmail('');
      setCreated(null);
      setError(null);
      setSubmitting(false);
    }
  }, [visible]);

  const canSubmit = name.trim().length > 0 && email.trim().length > 0 && !submitting;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.addUser(email.trim(), name.trim());
      setCreated(result);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('An account with that e-mail already exists.');
      } else if (err instanceof ApiError && err.status === 422) {
        setError('Enter a valid name and e-mail.');
      } else {
        setError('Could not add the person. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    onHide();
  }

  return (
    <Dialog
      header={created ? 'Person added' : 'Add person'}
      visible={visible}
      onHide={close}
      modal
      dismissableMask
      style={{ width: '30rem' }}
      breakpoints={{ '640px': '100vw' }}
    >
      {created ? (
        <div className="ui-authform">
          <AuthMessage tone="info">
            <strong>{created.user.display_name}</strong> can now set their password with the
            link below.
          </AuthMessage>
          <SetupLinkBox link={created} label="Setup link" />
          <div className="ui-authdialog-actions">
            <Button type="button" label="Done" onClick={close} />
          </div>
        </div>
      ) : (
        <form className="ui-authform" onSubmit={onSubmit} noValidate>
          {error && <AuthMessage tone="error">{error}</AuthMessage>}
          <AuthField
            id="add-name"
            label="Name"
            type="text"
            autoComplete="off"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Reader"
          />
          <AuthField
            id="add-email"
            label="E-mail"
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
          />
          <div className="ui-authdialog-actions">
            <Button type="button" label="Cancel" text onClick={close} disabled={submitting} />
            <Button
              type="submit"
              label={submitting ? 'Adding…' : 'Add person'}
              loading={submitting}
              disabled={!canSubmit}
            />
          </div>
        </form>
      )}
    </Dialog>
  );
}
