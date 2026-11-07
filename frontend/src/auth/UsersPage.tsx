import { Button } from 'primereact/button';
import { Column } from 'primereact/column';
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog';
import { DataTable } from 'primereact/datatable';
import { Dialog } from 'primereact/dialog';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../services/api';
import { Panel, Pill } from '../ui';
import { useAuth } from './AuthProvider';
import { AddPersonDialog } from './AddPersonDialog';
import { SetupLinkBox } from './SetupLinkBox';
import type { AdminUser, SetupLink } from './authTypes';
import './UsersPage.css';

/** Short local date for the "created" column. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Account status, one soft pill. */
function StatusPill({ user }: { user: AdminUser }) {
  if (user.disabled) {
    return <Pill tone="red" dot>Disabled</Pill>;
  }
  if (!user.has_password) {
    return <Pill tone="orange" dot>Pending setup</Pill>;
  }
  return <Pill tone="green" dot>Active</Pill>;
}

/**
 * UsersPage — the admin account list. A DataTable on desktop, a card list on
 * phones (same data, no horizontal scroll). "Add person" opens the invite dialog;
 * each row can mint a new setup link or be disabled/enabled with a confirm step.
 * No agent anchors: account management is never driven by the assistant.
 */
export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newLink, setNewLink] = useState<{ user: AdminUser; link: SetupLink } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listUsers();
      setUsers(list);
    } catch {
      setError('Could not load the user list.');
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminCount = (users ?? []).filter((u) => u.is_admin && !u.disabled).length;

  async function mintLink(user: AdminUser) {
    setBusyId(user.id);
    try {
      const link = await api.newSetupLink(user.id);
      setNewLink({ user, link });
    } catch {
      setError(`Could not create a new link for ${user.display_name}.`);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleDisabled(user: AdminUser) {
    setBusyId(user.id);
    try {
      await api.updateUser(user.id, { disabled: !user.disabled });
      await load();
    } catch {
      setError(`Could not update ${user.display_name}.`);
    } finally {
      setBusyId(null);
    }
  }

  function confirmToggle(user: AdminUser) {
    const disabling = !user.disabled;
    confirmDialog({
      header: disabling ? 'Disable account' : 'Enable account',
      message: disabling
        ? `Disable ${user.display_name}? They will be signed out of every device and cannot log in until re-enabled.`
        : `Enable ${user.display_name}? They will be able to log in again.`,
      icon: disabling ? 'pi pi-ban' : 'pi pi-check-circle',
      acceptLabel: disabling ? 'Disable' : 'Enable',
      rejectLabel: 'Cancel',
      acceptClassName: disabling ? 'p-button-danger' : undefined,
      accept: () => void toggleDisabled(user),
    });
  }

  /** The last active admin cannot be disabled (mirrors the server rule). */
  function lockedDisable(user: AdminUser): boolean {
    return user.is_admin && !user.disabled && adminCount <= 1;
  }

  function rowActions(user: AdminUser) {
    const locked = lockedDisable(user);
    return (
      <div className="users-row-actions">
        <Button
          label="New link"
          icon="pi pi-link"
          text
          size="small"
          loading={busyId === user.id}
          onClick={() => void mintLink(user)}
        />
        <Button
          label={user.disabled ? 'Enable' : 'Disable'}
          icon={user.disabled ? 'pi pi-check' : 'pi pi-ban'}
          text
          size="small"
          severity={user.disabled ? 'success' : 'danger'}
          disabled={locked || busyId === user.id}
          tooltip={locked ? 'The last active admin cannot be disabled.' : undefined}
          onClick={() => confirmToggle(user)}
        />
      </div>
    );
  }

  const count = users?.length ?? 0;
  const actions = (
    <Button label="Add person" icon="pi pi-user-plus" onClick={() => setAddOpen(true)} />
  );

  return (
    <div className="users-page">
      <Panel label="Accounts" icon="pi pi-users" actions={actions}>
        {error && <p className="users-error" role="alert">{error}</p>}

        {users === null ? (
          <p className="users-empty">Loading accounts…</p>
        ) : count === 0 ? (
          <p className="users-empty">No accounts yet. Add the first person.</p>
        ) : (
          <>
            {/* Desktop / tablet: a table. */}
            <div className="users-table">
              <DataTable value={users} dataKey="id" stripedRows>
                <Column
                  header="Name"
                  body={(u: AdminUser) => (
                    <div className="users-name-cell">
                      <span className="users-name">{u.display_name}</span>
                      {u.is_admin && <Pill tone="violet">Admin</Pill>}
                      {me?.id === u.id && <Pill tone="blue">You</Pill>}
                    </div>
                  )}
                />
                <Column header="E-mail" field="email" />
                <Column header="Status" body={(u: AdminUser) => <StatusPill user={u} />} />
                <Column
                  header="Books"
                  body={(u: AdminUser) => (
                    <span className="users-books">{u.book_count}</span>
                  )}
                />
                <Column header="Created" body={(u: AdminUser) => formatDate(u.created_at)} />
                <Column header="" body={rowActions} align="right" />
              </DataTable>
            </div>

            {/* Phones: a card per account. */}
            <ul className="users-cards" aria-label="Accounts">
              {users.map((u) => (
                <li key={u.id} className="users-card">
                  <div className="users-card-head">
                    <div className="users-name-cell">
                      <span className="users-name">{u.display_name}</span>
                      {u.is_admin && <Pill tone="violet">Admin</Pill>}
                      {me?.id === u.id && <Pill tone="blue">You</Pill>}
                    </div>
                    <StatusPill user={u} />
                  </div>
                  <div className="users-card-email">{u.email}</div>
                  <div className="users-card-meta">
                    <span>{u.book_count} books</span>
                    <span aria-hidden="true">·</span>
                    <span>Joined {formatDate(u.created_at)}</span>
                  </div>
                  {rowActions(u)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <AddPersonDialog
        visible={addOpen}
        onHide={() => setAddOpen(false)}
        onCreated={() => void load()}
      />

      <Dialog
        header="New setup link"
        visible={newLink !== null}
        onHide={() => setNewLink(null)}
        modal
        dismissableMask
        style={{ width: '30rem' }}
        breakpoints={{ '640px': '100vw' }}
      >
        {newLink && (
          <div className="ui-authform">
            <p className="users-link-intro">
              A fresh link for <strong>{newLink.user.display_name}</strong>. The previous link,
              if any, no longer works.
            </p>
            <SetupLinkBox link={newLink.link} label="Setup link" />
            <div className="ui-authdialog-actions">
              <Button type="button" label="Done" onClick={() => setNewLink(null)} />
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog />
    </div>
  );
}
