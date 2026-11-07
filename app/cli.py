"""Shelfie command line: account management and the all-users series check.

    uv run python -m app.cli users bootstrap --email E --name N
    uv run python -m app.cli users add --email E --name N
    uv run python -m app.cli users setup-link --email E
    uv run python -m app.cli users list
    uv run python -m app.cli series check --all-users

``bootstrap`` is the one-time migration from the legacy single-user layout to the
per-user layout: it backs up ``data/``, creates admin user 1, moves the legacy library
into ``data/users/1/``, verifies the row counts of books / comparisons / series_info /
expected_books are unchanged, and prints a setup link. It refuses to run a second time.
See ``docs/features/auth.md`` and ``docs/features/cli.md``.
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from app import authdb
from app.config import Settings, get_settings
from app.services import auth_service
from app.userdata import UserData

ADMIN_ID = 1
DEFAULT_ORIGIN = "http://127.0.0.1:5174"

# Tables whose row counts bootstrap must preserve when moving the legacy library.
_COUNTED_TABLES = ("books", "comparisons", "series_info", "expected_books")


def _row_counts(db_file: Path) -> dict[str, int]:
    conn = sqlite3.connect(db_file)
    try:
        counts: dict[str, int] = {}
        for table in _COUNTED_TABLES:
            try:
                row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()  # nosec B608
                counts[table] = int(row[0]) if row else 0
            except sqlite3.Error:
                counts[table] = 0
        return counts
    finally:
        conn.close()


async def _bootstrap(settings: Settings, email: str, name: str, origin: str) -> int:
    auth_db = settings.auth_database_file
    await authdb.init_auth_db(auth_db)
    conn = await authdb.connect(auth_db)
    try:
        existing = await authdb.get_user(conn, ADMIN_ID)
        if existing is not None:
            print(
                f"Refusing: admin user {ADMIN_ID} already exists ({existing.email}). "
                "Bootstrap has already run.",
                file=sys.stderr,
            )
            return 2

        legacy_db = settings.database_file
        legacy_dataset = settings.dataset_file
        legacy_covers = settings.covers_path
        before = (
            _row_counts(legacy_db) if legacy_db.is_file() else dict.fromkeys(_COUNTED_TABLES, 0)
        )

        # 1) Back up the whole data root first.
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = settings.data_path / f"backup-auth-{stamp}"
        backup_dir.mkdir(parents=True, exist_ok=False)
        for src in (legacy_db, legacy_dataset):
            if src.is_file():
                shutil.copy2(src, backup_dir / src.name)
        for suffix in ("-wal", "-shm"):
            sidecar = legacy_db.with_name(legacy_db.name + suffix)
            if sidecar.is_file():
                shutil.copy2(sidecar, backup_dir / sidecar.name)
        if legacy_covers.is_dir():
            shutil.copytree(legacy_covers, backup_dir / "covers")
        print(f"Backed up data to {backup_dir}")

        # 2) Create the admin account with id 1.
        admin = await auth_service.create_account(
            conn, settings, email=email, display_name=name, is_admin=True, user_id=ADMIN_ID
        )

        # 3) Move the legacy library into data/users/1/.
        target = UserData.for_user(settings.data_path, ADMIN_ID)
        target.ensure_dirs()
        if legacy_db.is_file():
            shutil.move(str(legacy_db), str(target.database_file))
            for suffix in ("-wal", "-shm"):
                sidecar = legacy_db.with_name(legacy_db.name + suffix)
                if sidecar.is_file():
                    shutil.move(str(sidecar), str(target.database_file) + suffix)
        if legacy_dataset.is_file():
            shutil.move(str(legacy_dataset), str(target.dataset_file))
        if legacy_covers.is_dir():
            if target.covers_dir.exists():
                for item in legacy_covers.iterdir():
                    shutil.move(str(item), str(target.covers_dir / item.name))
                legacy_covers.rmdir()
            else:
                shutil.move(str(legacy_covers), str(target.covers_dir))

        # 4) Verify the row counts survived the move.
        after = _row_counts(target.database_file) if target.database_file.is_file() else before
        mismatches = {t: (before[t], after[t]) for t in _COUNTED_TABLES if before[t] != after[t]}
        if mismatches:
            print(f"ERROR: row counts changed during move: {mismatches}", file=sys.stderr)
            return 3
        print("Row counts preserved: " + ", ".join(f"{t}={after[t]}" for t in _COUNTED_TABLES))

        # 5) Print a setup link so the admin can set a password.
        setup_url, expires = await auth_service.issue_setup_link(
            conn, settings, user_id=admin.id, purpose="setup", origin=origin
        )
        print(f"\nAdmin account created: {admin.email} (id {admin.id})")
        print(f"Set a password with this link (valid {settings.setup_token_hours} h, single use):")
        print(f"  {setup_url}")
        print(f"  expires: {expires.isoformat()}")
        return 0
    finally:
        await conn.close()


async def _add(settings: Settings, email: str, name: str, origin: str) -> int:
    conn = await authdb.connect(settings.auth_database_file)
    try:
        try:
            user = await auth_service.create_account(conn, settings, email=email, display_name=name)
        except auth_service.EmailTaken:
            print(f"A user with e-mail {email} already exists.", file=sys.stderr)
            return 2
        setup_url, expires = await auth_service.issue_setup_link(
            conn, settings, user_id=user.id, purpose="setup", origin=origin
        )
        print(f"User created: {user.email} (id {user.id})")
        print(f"Setup link (valid {settings.setup_token_hours} h, single use):")
        print(f"  {setup_url}")
        print(f"  expires: {expires.isoformat()}")
        return 0
    finally:
        await conn.close()


async def _setup_link(settings: Settings, email: str, origin: str) -> int:
    conn = await authdb.connect(settings.auth_database_file)
    try:
        user = await authdb.get_user_by_email(conn, email)
        if user is None:
            print(f"No user with e-mail {email}.", file=sys.stderr)
            return 2
        purpose = "setup" if not user.has_password else "reset"
        setup_url, expires = await auth_service.issue_setup_link(
            conn, settings, user_id=user.id, purpose=purpose, origin=origin
        )
        print(
            f"{purpose.capitalize()} link for {user.email} (valid {settings.setup_token_hours} h):"
        )
        print(f"  {setup_url}")
        print(f"  expires: {expires.isoformat()}")
        return 0
    finally:
        await conn.close()


async def _list(settings: Settings) -> int:
    conn = await authdb.connect(settings.auth_database_file)
    try:
        users = await authdb.list_users(conn)
        if not users:
            print("No users. Run `users bootstrap` first.")
            return 0
        print(f"{'id':>3}  {'email':40}  {'admin':5}  {'disabled':8}  {'password':8}  books")
        for u in users:
            data = UserData.for_user(settings.data_path, u.id)
            books = await auth_service.book_count(data)
            print(
                f"{u.id:>3}  {u.email:40}  "
                f"{'yes' if u.is_admin else 'no':5}  "
                f"{'yes' if u.disabled else 'no':8}  "
                f"{'set' if u.has_password else 'none':8}  {books}"
            )
        return 0
    finally:
        await conn.close()


async def _series_check_all(settings: Settings) -> int:
    from app.services import series_service

    conn = await authdb.connect(settings.auth_database_file)
    try:
        users = await authdb.list_users(conn)
    finally:
        await conn.close()
    active = [u for u in users if not u.disabled]
    total_checked = 0
    total_updated = 0
    for u in active:
        data = UserData.for_user(settings.data_path, u.id)
        if not data.database_file.is_file():
            print(f"user {u.id} ({u.email}): no library yet, skipped")
            continue
        result = await series_service.check_watched_series(
            db_file=data.database_file, settings=settings, user_id=1
        )
        total_checked += result.checked
        total_updated += result.updated
        print(f"user {u.id} ({u.email}): checked {result.checked}, updated {result.updated}")
    print(f"Done. {len(active)} users, checked {total_checked}, updated {total_updated}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app.cli", description=__doc__)
    sub = parser.add_subparsers(dest="group", required=True)

    users = sub.add_parser("users", help="Account management").add_subparsers(
        dest="action", required=True
    )

    boot = users.add_parser("bootstrap", help="One-time migration to the per-user layout")
    boot.add_argument("--email", required=True)
    boot.add_argument("--name", required=True)
    boot.add_argument("--origin", default=DEFAULT_ORIGIN, help=f"default {DEFAULT_ORIGIN}")

    add = users.add_parser("add", help="Create a user with an empty library")
    add.add_argument("--email", required=True)
    add.add_argument("--name", required=True)
    add.add_argument("--origin", default=DEFAULT_ORIGIN)

    link = users.add_parser("setup-link", help="Print a new setup/reset link")
    link.add_argument("--email", required=True)
    link.add_argument("--origin", default=DEFAULT_ORIGIN)

    users.add_parser("list", help="List accounts")

    series = sub.add_parser("series", help="Series maintenance").add_subparsers(
        dest="action", required=True
    )
    check = series.add_parser("check", help="Re-check watched series")
    check.add_argument("--all-users", action="store_true", help="Check every active user's library")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = get_settings()

    if args.group == "users":
        if args.action == "bootstrap":
            return asyncio.run(_bootstrap(settings, args.email, args.name, args.origin))
        if args.action == "add":
            return asyncio.run(_add(settings, args.email, args.name, args.origin))
        if args.action == "setup-link":
            return asyncio.run(_setup_link(settings, args.email, args.origin))
        if args.action == "list":
            return asyncio.run(_list(settings))
    if args.group == "series" and args.action == "check":
        if not args.all_users:
            print("Only --all-users is supported from the CLI.", file=sys.stderr)
            return 2
        return asyncio.run(_series_check_all(settings))
    return 1


if __name__ == "__main__":
    sys.exit(main())
