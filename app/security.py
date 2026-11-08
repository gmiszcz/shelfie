"""Password hashing (argon2id) and opaque-token helpers.

Passwords are hashed with argon2id via ``argon2-cffi`` (library defaults). Session and
setup tokens are 32 random url-safe bytes; only their SHA-256 hash is ever stored, so a
leaked database row cannot be replayed as a cookie. Nothing here logs a secret.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# One hasher for the process; argon2id is the default type in argon2-cffi.
_hasher = PasswordHasher()

# A valid argon2id hash of a random string, used for the dummy verify on an unknown
# e-mail so a failed login takes the same time whether or not the account exists.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(32))

#: Raw token length in bytes; ``token_urlsafe`` yields ~43 chars for 32 bytes.
TOKEN_BYTES = 32


def configure_hasher(hasher: PasswordHasher) -> None:
    """Replace the process hasher (and its dummy hash).

    Production uses argon2-cffi's defaults. The test suite installs a cheap-parameter hasher
    so the many login/setup flows do not each pay the full argon2 cost — this changes nothing
    about the stored format, only the cost parameters used while tests run.
    """
    global _hasher, _DUMMY_HASH
    _hasher = hasher
    _DUMMY_HASH = hasher.hash(secrets.token_urlsafe(32))


def hash_password(password: str) -> str:
    """Return an argon2id hash string for ``password``."""
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Verify ``password`` against ``stored_hash``.

    When ``stored_hash`` is ``None`` (account has no password yet) a dummy verify is still
    run so the timing does not reveal whether the account exists, then ``False`` returned.
    """
    target = stored_hash or _DUMMY_HASH
    try:
        _hasher.verify(target, password)
    except (VerifyMismatchError, Exception):  # noqa: BLE001 - any verify failure is a non-match
        return False
    return stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    """True when ``stored_hash`` was made with weaker parameters than the current policy."""
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except Exception:  # noqa: BLE001 - treat an unreadable hash as not needing rehash
        return False


def generate_token() -> str:
    """A fresh url-safe token (the raw secret handed to the client, never stored)."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """SHA-256 hex digest of a token — this is what the database stores."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    """Constant-time comparison of two token hashes."""
    return hmac.compare_digest(a, b)
