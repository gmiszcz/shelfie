"""Auth seam.

Single-user today: ``current_user_id`` returns the constant seed user. The dependency exists so
every route already depends on an authenticated user and every query filters by ``user_id``.
Flipping to JWT/SSO later means validating a token here and mapping its subject to a user row —
no route signature changes.
"""

from __future__ import annotations

from app.db import SINGLE_USER_ID


def current_user_id() -> int:
    return SINGLE_USER_ID
