"""Per-user data paths and the request-scoped context that carries them.

Every person has their own data folder ``data/users/<id>/`` holding their SQLite library,
their ``books.json`` mirror and their uploaded covers (see ``docs/features/auth.md``). The
library code must never read a global path again: it resolves the *current* user's files
through the :data:`CURRENT_USER_DATA` context variable.

A request sets the context var in a dependency (``app.api.deps.user_data``). Background tasks
and the agent tools, which have no request object, capture a :class:`UserData` explicitly when
they are scheduled and set the context var inside the task. When no context is set, reading a
path raises :class:`NoUserContext` — there is no silent global default.
"""

from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class NoUserContext(RuntimeError):
    """Raised when library data is accessed with no user context set.

    This is deliberate: a missing context means a bug (a route that forgot the
    ``current_user`` dependency, or a background task that did not capture its
    ``UserData``), never a reason to fall back to a shared global library.
    """


@dataclass(frozen=True)
class UserData:
    """The on-disk library of one user. Immutable; built from the data root + user id."""

    user_id: int
    root: Path

    @classmethod
    def for_user(cls, data_root: Path, user_id: int) -> UserData:
        """Build the ``data/users/<id>/`` layout for ``user_id`` under ``data_root``."""
        return cls(user_id=user_id, root=data_root / "users" / str(user_id))

    @property
    def database_file(self) -> Path:
        return self.root / "shelfie.sqlite"

    @property
    def dataset_file(self) -> Path:
        return self.root / "books.json"

    @property
    def covers_dir(self) -> Path:
        return self.root / "covers"

    def ensure_dirs(self) -> None:
        """Create the user's data folder and covers folder (idempotent)."""
        self.root.mkdir(parents=True, exist_ok=True)
        self.covers_dir.mkdir(parents=True, exist_ok=True)


CURRENT_USER_DATA: contextvars.ContextVar[UserData] = contextvars.ContextVar("current_user_data")


def get_current_user_data() -> UserData:
    """Return the current user's :class:`UserData`, or raise :class:`NoUserContext`.

    This is the single choke point every data-access path funnels through, so a missing
    context fails loudly instead of silently reading someone else's — or a shared — library.
    """
    try:
        return CURRENT_USER_DATA.get()
    except LookupError as exc:  # no .set() on this context
        raise NoUserContext(
            "no user context set; a request dependency or a background task must set "
            "CURRENT_USER_DATA before any library data is accessed"
        ) from exc


def set_current_user_data(user_data: UserData) -> contextvars.Token[UserData]:
    """Set the current user's data for this context; returns a reset token."""
    return CURRENT_USER_DATA.set(user_data)


@contextmanager
def using_user_data(user_data: UserData) -> Iterator[UserData]:
    """Scope ``user_data`` as the current context for the duration of the ``with`` block.

    Used by background tasks and the CLI, which have no request to set the var for them.
    """
    token = CURRENT_USER_DATA.set(user_data)
    try:
        yield user_data
    finally:
        CURRENT_USER_DATA.reset(token)


def current_database_file() -> Path:
    """The current user's library SQLite file (raises if no context)."""
    return get_current_user_data().database_file


def current_dataset_file() -> Path:
    """The current user's ``books.json`` mirror (raises if no context)."""
    return get_current_user_data().dataset_file


def current_covers_dir() -> Path:
    """The current user's covers folder (raises if no context)."""
    return get_current_user_data().covers_dir
