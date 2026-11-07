/** Auth domain types — the shape of the accounts/login contract (docs/features/auth.md). */

/** The logged-in person, as returned by GET /api/auth/me and the login/setup endpoints. */
export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
}

/** What a setup/reset link resolves to (GET /api/auth/setup/{token}). */
export interface SetupTokenInfo {
  email: string;
  display_name: string;
  purpose: 'setup' | 'reset';
}

/** One account row in the admin Users list (GET /api/admin/users). */
export interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  has_password: boolean;
  created_at: string;
  book_count: number;
}

/** The result of creating a user or minting a new setup link. */
export interface SetupLink {
  setup_url: string;
  expires_at: string;
}

/** POST /api/admin/users returns the new user plus its first setup link. */
export interface CreatedUser extends SetupLink {
  user: AdminUser;
}
