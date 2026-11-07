"""Daily backup of everything personal under ``data/``.

What is copied into ``<backup_root>/<YYYYMMDD-HHMMSS>/``:

- ``auth.sqlite`` (accounts, sessions);
- every ``users/<id>/`` folder: ``shelfie.sqlite``, ``books.json``, ``covers/``.

SQLite files are copied with the SQLite online-backup API, so a backup taken while the
server is writing is still consistent (a plain file copy could catch a half-written page).
Caches (``data/cache``) are not personal and are skipped.

After a successful run only the newest ``keep`` backups are kept. A run that fails part
way leaves a ``.partial`` folder that is never counted as a good backup and is removed on
the next run.
"""

from __future__ import annotations

import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

PARTIAL_SUFFIX = ".partial"


@dataclass(frozen=True)
class BackupResult:
    path: Path
    users: int
    files: int
    removed: list[Path]


def _copy_sqlite(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(dst)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()


def _is_backup_dir(p: Path) -> bool:
    return (
        p.is_dir() and len(p.name) == 15 and p.name[8] == "-" and p.name.replace("-", "").isdigit()
    )


def run_backup(
    data_dir: Path, backup_root: Path, keep: int = 14, auth_file: Path | None = None
) -> BackupResult:
    """Back up ``data_dir`` into a new timestamped folder and prune old ones.

    ``auth_file`` defaults to ``data_dir/auth.sqlite``.
    """
    if keep < 1:
        raise ValueError("keep must be at least 1")
    backup_root.mkdir(parents=True, exist_ok=True)

    # Clean up leftovers of a run that crashed before.
    for leftover in backup_root.glob(f"*{PARTIAL_SUFFIX}"):
        shutil.rmtree(leftover, ignore_errors=True)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    final = backup_root / stamp
    work = backup_root / f"{stamp}{PARTIAL_SUFFIX}"
    work.mkdir()

    files = 0
    auth = auth_file or data_dir / "auth.sqlite"
    if auth.is_file():
        _copy_sqlite(auth, work / "auth.sqlite")
        files += 1

    users = 0
    users_dir = data_dir / "users"
    if users_dir.is_dir():
        for user in sorted(p for p in users_dir.iterdir() if p.is_dir()):
            users += 1
            target = work / "users" / user.name
            target.mkdir(parents=True, exist_ok=True)
            for item in user.iterdir():
                if item.suffix == ".sqlite" and item.is_file():
                    _copy_sqlite(item, target / item.name)
                    files += 1
                elif item.suffix in {".sqlite-wal", ".sqlite-shm"} or item.name.endswith(
                    ("-wal", "-shm", "-journal")
                ):
                    continue  # folded in by the online backup
                elif item.is_dir():
                    shutil.copytree(item, target / item.name)
                    files += sum(1 for f in (target / item.name).rglob("*") if f.is_file())
                elif item.is_file():
                    shutil.copy2(item, target / item.name)
                    files += 1

    work.rename(final)

    backups = sorted((p for p in backup_root.iterdir() if _is_backup_dir(p)), key=lambda p: p.name)
    removed: list[Path] = []
    for old in backups[:-keep]:
        shutil.rmtree(old, ignore_errors=True)
        removed.append(old)
    return BackupResult(path=final, users=users, files=files, removed=removed)
