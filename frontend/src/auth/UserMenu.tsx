import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import type { MenuItem } from 'primereact/menuitem';
import { useRef, useState } from 'react';

import { AccountDialog } from './AccountDialog';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { useAuth } from './AuthProvider';
import './UserMenu.css';

interface UserMenuProps {
  /** Open the admin Users page. */
  onOpenUsers: () => void;
  /**
   * On phones the menu trigger lives in the bottom tab bar as a full tab, so the
   * label + icon read like the other tabs. On desktop it is a compact avatar
   * button in the top bar.
   */
  variant?: 'bar' | 'tab';
  /** Marks the phone tab active (when the menu is open). */
  active?: boolean;
}

/** First letter(s) of the display name, for the avatar chip. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * UserMenu — the account control. A popup menu with the person's name, "Change
 * password", "Users" (admin only) and "Log out". No agent anchors: the assistant
 * must never log anyone in or out or manage accounts.
 */
export function UserMenu({ onOpenUsers, variant = 'bar', active = false }: UserMenuProps) {
  const { user, logout } = useAuth();
  const menuRef = useRef<Menu>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  if (!user) return null;

  const items: MenuItem[] = [
    {
      // A non-interactive header: who is signed in.
      template: (
        <div className="user-menu-head" key="head">
          <span className="user-menu-avatar" aria-hidden="true">
            {initials(user.display_name)}
          </span>
          <span className="user-menu-identity">
            <span className="user-menu-name">{user.display_name}</span>
            <span className="user-menu-email">{user.email}</span>
          </span>
        </div>
      ),
    },
    { separator: true },
    {
      label: 'Account',
      icon: 'pi pi-user',
      command: () => setAccountOpen(true),
    },
    {
      label: 'Change password',
      icon: 'pi pi-key',
      command: () => setChangeOpen(true),
    },
    ...(user.is_admin
      ? [
          {
            label: 'Users',
            icon: 'pi pi-users',
            command: () => onOpenUsers(),
          } as MenuItem,
        ]
      : []),
    { separator: true },
    {
      label: 'Log out',
      icon: 'pi pi-sign-out',
      command: () => {
        void logout();
      },
    },
  ];

  return (
    <>
      <Menu model={items} popup ref={menuRef} id="user-menu-popup" className="user-menu-popup" />
      {variant === 'tab' ? (
        <button
          type="button"
          className={`app-nav-item ${active ? 'active' : ''}`}
          aria-haspopup
          aria-controls="user-menu-popup"
          aria-label={`Account: ${user.display_name}`}
          onClick={(e) => menuRef.current?.toggle(e)}
        >
          <i className="pi pi-user" />
          <span>Account</span>
        </button>
      ) : (
        <Button
          className="user-menu-trigger"
          rounded
          text
          aria-haspopup
          aria-controls="user-menu-popup"
          aria-label={`Account: ${user.display_name}`}
          onClick={(e) => menuRef.current?.toggle(e)}
        >
          <span className="user-menu-avatar" aria-hidden="true">
            {initials(user.display_name)}
          </span>
        </Button>
      )}
      <AccountDialog
        visible={accountOpen}
        onHide={() => setAccountOpen(false)}
        onChangePassword={() => {
          setAccountOpen(false);
          setChangeOpen(true);
        }}
      />
      <ChangePasswordDialog visible={changeOpen} onHide={() => setChangeOpen(false)} />
    </>
  );
}
