"""Shared helpers for the Wave 4 data-maintenance scripts.

Both ``fill_covers`` and ``fix_series_titles`` edit the SAME two stores: the JSON dataset
``data/books.json`` (the source of truth) and the live SQLite database the running backend
reads. These helpers keep the two scripts honest about three things that must never go wrong:

* **Back up first.** :func:`backup_data` copies both stores into
  ``data/backup-wave4-<timestamp>/`` before anything is touched.
* **Match, never rebuild.** :func:`match_db_id` finds the single ``books.id`` for a JSON
  record by identity (Google volume id, then ISBN-13/10, then external id, then title+authors).
  The database is updated with targeted ``UPDATE``\\ s by id only -- tables are never dropped
  and the ``comparisons`` table is never touched.
* **Prove the rating log is intact.** :func:`count_comparisons` is read before and after a run
  so the caller can assert the count is unchanged.

Writes to the JSON file are atomic (temp file + ``os.replace``); writes to SQLite use a short
``busy_timeout`` so they coexist with the read-only backend without being restarted.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

# The backend's single-user constant (see app.db.SINGLE_USER_ID). Kept local so these
# maintenance scripts do not import the app package just for one integer.
SINGLE_USER_ID = 1


def load_dataset(path: Path) -> dict[str, Any]:
    """Read ``data/books.json`` as a dict with a ``books`` list. Raises on a bad shape."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("books"), list):
        raise ValueError(f"{path} must be an object with a 'books' list")
    return payload


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON to a temp file in the same directory, then atomically replace the target."""
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def backup_data(data_dir: Path, db_file: Path, dataset_file: Path) -> Path:
    """Copy the dataset and the DB (plus any WAL/SHM sidecars) into a timestamped folder.

    Returns the backup directory. Call this once, before any mutation.
    """
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = data_dir / f"backup-wave4-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    for src in (dataset_file, db_file):
        if src.is_file():
            (backup_dir / src.name).write_bytes(src.read_bytes())
    for suffix in ("-wal", "-shm"):
        sidecar = db_file.with_name(db_file.name + suffix)
        if sidecar.is_file():
            (backup_dir / sidecar.name).write_bytes(sidecar.read_bytes())
    return backup_dir


def connect_db(db_file: Path) -> sqlite3.Connection:
    """Open the SQLite DB for targeted updates, tolerant of the live backend holding it."""
    conn = sqlite3.connect(db_file, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def count_comparisons(conn: sqlite3.Connection, user_id: int = SINGLE_USER_ID) -> int:
    """Number of rows in the comparisons table for the user (the rating-engine source of truth)."""
    row = conn.execute("SELECT COUNT(*) FROM comparisons WHERE user_id = ?", (user_id,)).fetchone()
    return int(row[0]) if row else 0


def _norm(text: str | None) -> str:
    return (text or "").strip().casefold()


def _authors_key(authors: Any) -> str:
    if isinstance(authors, str):
        try:
            authors = json.loads(authors)
        except (ValueError, TypeError):
            authors = [authors]
    if not isinstance(authors, list):
        return ""
    return "|".join(sorted(_norm(a) for a in authors if a))


def load_db_index(conn: sqlite3.Connection, user_id: int = SINGLE_USER_ID) -> dict[str, Any]:
    """Build lookup tables from DB rows so a JSON record can be matched to exactly one id.

    Returns a dict with per-key maps. A key that maps to MORE than one id is dropped from that
    map (ambiguous), so a caller never updates the wrong row on a collision.
    """
    rows = conn.execute(
        "SELECT id, google_volume_id, isbn_13, isbn_10, external_id, title, authors "
        "FROM books WHERE user_id = ?",
        (user_id,),
    ).fetchall()

    def _single(pairs: list[tuple[str, int]]) -> dict[str, int]:
        seen: dict[str, list[int]] = {}
        for key, book_id in pairs:
            if key:
                seen.setdefault(key, []).append(book_id)
        return {k: v[0] for k, v in seen.items() if len(v) == 1}

    by_vol = _single([(r["google_volume_id"], r["id"]) for r in rows])
    by_isbn13 = _single([(r["isbn_13"], r["id"]) for r in rows])
    by_isbn10 = _single([(r["isbn_10"], r["id"]) for r in rows])
    by_ext = _single([(r["external_id"], r["id"]) for r in rows])
    by_title_authors = _single(
        [(f"{_norm(r['title'])}\u0000{_authors_key(r['authors'])}", r["id"]) for r in rows]
    )
    return {
        "rows": rows,
        "by_vol": by_vol,
        "by_isbn13": by_isbn13,
        "by_isbn10": by_isbn10,
        "by_ext": by_ext,
        "by_title_authors": by_title_authors,
    }


def match_db_id(record: dict[str, Any], index: dict[str, Any]) -> int | None:
    """Find the single ``books.id`` for a JSON record, trying the strongest key first.

    Order: Google volume id, ISBN-13, ISBN-10, external id, then title+authors. Returns
    ``None`` when no unambiguous match exists (the caller then reports it rather than guessing).
    """
    vol = record.get("google_volume_id")
    if vol and vol in index["by_vol"]:
        return index["by_vol"][vol]
    isbn13 = record.get("isbn_13")
    if isbn13 and isbn13 in index["by_isbn13"]:
        return index["by_isbn13"][isbn13]
    isbn10 = record.get("isbn_10")
    if isbn10 and isbn10 in index["by_isbn10"]:
        return index["by_isbn10"][isbn10]
    ext = record.get("external_id")
    if ext and ext in index["by_ext"]:
        return index["by_ext"][ext]
    key = f"{_norm(record.get('title'))}\u0000{_authors_key(record.get('authors'))}"
    return index["by_title_authors"].get(key)


# --- per-user path resolution (wave 5 accounts) -----------------------------------------

from dataclasses import dataclass  # noqa: E402


@dataclass(frozen=True)
class UserPaths:
    """The per-user data layout used by the maintenance scripts (``--user``)."""

    user_id: int
    data_dir: Path
    db_file: Path
    dataset_file: Path
    covers_dir: Path


def _resolve_user_id(data_dir: Path, user: str) -> int:
    """Map a ``--user`` (numeric id or e-mail) to a user id using ``data/auth.sqlite``.

    A bare integer is taken as the id directly (so the scripts work before/without the auth
    DB). An e-mail is looked up in the auth DB; a missing DB or e-mail raises ``SystemExit``.
    """
    text = (user or "").strip()
    if text.isdigit():
        return int(text)
    auth_db = data_dir / "auth.sqlite"
    if not auth_db.is_file():
        raise SystemExit(f"--user {user!r} is an e-mail but {auth_db} does not exist")
    conn = sqlite3.connect(auth_db)
    try:
        row = conn.execute("SELECT id FROM users WHERE email = ?", (text.lower(),)).fetchone()
    except sqlite3.Error as exc:
        raise SystemExit(f"could not read {auth_db}: {exc}") from exc
    finally:
        conn.close()
    if row is None:
        raise SystemExit(f"no user with e-mail {user!r} in {auth_db}")
    return int(row[0])


def resolve_user_paths(root: Path, user: str = "1") -> UserPaths:
    """Resolve the ``data/users/<id>/`` paths for ``--user`` under a checkout ``root``.

    ``user`` is a numeric id or an e-mail (resolved via ``data/auth.sqlite``). Defaults to
    the first admin (id 1), matching the single-admin bootstrap.
    """
    data_dir = root / "data"
    user_id = _resolve_user_id(data_dir, user)
    user_root = data_dir / "users" / str(user_id)
    return UserPaths(
        user_id=user_id,
        data_dir=data_dir,
        db_file=user_root / "shelfie.sqlite",
        dataset_file=user_root / "books.json",
        covers_dir=user_root / "covers",
    )
