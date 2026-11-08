import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthField, AuthMessage } from '../ui';
import { useAuth } from './AuthProvider';

interface AccountDialogProps {
  visible: boolean;
  onHide: () => void;
  /** Open the change-password dialog. */
  onChangePassword: () => void;
}

/**
 * AccountDialog — the user panel: edit your name, see your e-mail and role,
 * change your password, log out.
 */
export function AccountDialog({ visible, onHide, onChangePassword }: AccountDialogProps) {
  const { user, updateProfile, logout } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && user) {
      setName(user.display_name);
      setError(null);
      setSaved(false);
      setSaving(false);
    }
  }, [visible, user]);

  if (!user) return null;

  const changed = name.trim().length > 0 && name.trim() !== user.display_name;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!changed || saving) return;
    setError(null);
    setSaving(true);
    try {
      await updateProfile(name.trim());
      setSaved(true);
    } catch {
      setError('Could not save your name. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      header="Account"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: '28rem' }}
      breakpoints={{ '640px': '100vw' }}
    >
      <div className="account-panel">
        <form className="ui-authform" onSubmit={onSubmit} noValidate>
          {error && <AuthMessage tone="error">{error}</AuthMessage>}
          {saved && <AuthMessage tone="info">Saved.</AuthMessage>}
          <AuthField
            id="acc-name"
            label="Name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          <AuthField id="acc-email" label="E-mail" value={user.email} disabled readOnly />
          <p className="account-role">{user.is_admin ? 'Admin account' : 'Standard account'}</p>
          <div className="ui-authdialog-actions">
            <Button
              type="submit"
              label={saving ? 'Saving…' : 'Save name'}
              loading={saving}
              disabled={!changed || saving}
            />
          </div>
        </form>
        <div className="account-actions">
          <Button
            type="button"
            icon="pi pi-key"
            label="Change password"
            outlined
            onClick={onChangePassword}
          />
          <Button
            type="button"
            icon="pi pi-sign-out"
            label="Log out"
            text
            severity="secondary"
            onClick={() => {
              onHide();
              void logout();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
