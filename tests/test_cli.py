"""CLI tests: bootstrap migration (count preservation, single-run), and series check --all-users."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app import cli
from app.config import get_settings

# Row counts the bootstrap must preserve (mirrors the live-data assertion in the brief).
SEED_BOOKS = 5
SEED_COMPARISONS = 3
SEED_SERIES = 2
SEED_EXPECTED = 1


def _seed_legacy(data_dir: Path) -> None:
    """Create a legacy single-user layout: data/shelfie.sqlite + books.json + covers/."""
    data_dir.mkdir(parents=True, exist_ok=True)
    db = data_dir / "shelfie.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT);
        CREATE TABLE books (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT,
                            series TEXT, watch INTEGER DEFAULT 0);
        CREATE TABLE comparisons (id INTEGER PRIMARY KEY, user_id INTEGER, winner TEXT);
        CREATE TABLE series_info (id INTEGER PRIMARY KEY, user_id INTEGER, series_key TEXT,
                                  display_name TEXT, watch INTEGER DEFAULT 0);
        CREATE TABLE expected_books (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);
        """
    )
    conn.execute("INSERT INTO users (id, display_name) VALUES (1, 'Legacy')")
    for i in range(SEED_BOOKS):
        conn.execute("INSERT INTO books (user_id, title) VALUES (1, ?)", (f"B{i}",))
    for _ in range(SEED_COMPARISONS):
        conn.execute("INSERT INTO comparisons (user_id, winner) VALUES (1, 'left')")
    for i in range(SEED_SERIES):
        conn.execute(
            "INSERT INTO series_info (user_id, series_key, display_name) VALUES (1, ?, ?)",
            (f"s{i}", f"Series {i}"),
        )
    for i in range(SEED_EXPECTED):
        conn.execute("INSERT INTO expected_books (user_id, title) VALUES (1, ?)", (f"E{i}",))
    conn.commit()
    conn.close()
    (data_dir / "books.json").write_text(
        json.dumps({"version": 1, "books": []}, ensure_ascii=False), encoding="utf-8"
    )
    (data_dir / "covers").mkdir()
    (data_dir / "covers" / "x.jpg").write_bytes(b"\xff\xd8\xff")


def _counts(db: Path) -> dict[str, int]:
    conn = sqlite3.connect(db)
    try:
        return {
            t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]  # noqa: S608
            for t in ("books", "comparisons", "series_info", "expected_books")
        }
    finally:
        conn.close()


def test_bootstrap_moves_legacy_and_preserves_counts(data_root: Path, capsys) -> None:
    _seed_legacy(data_root)
    rc = cli.main(["users", "bootstrap", "--email", "patryk@example.com", "--name", "Patryk"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "/setup?token=" in out

    user_db = data_root / "users" / "1" / "shelfie.sqlite"
    assert user_db.is_file()
    # Legacy paths are gone.
    assert not (data_root / "shelfie.sqlite").exists()
    assert not (data_root / "books.json").exists()
    # Counts preserved across the move.
    assert _counts(user_db) == {
        "books": SEED_BOOKS,
        "comparisons": SEED_COMPARISONS,
        "series_info": SEED_SERIES,
        "expected_books": SEED_EXPECTED,
    }
    # Backup was made.
    assert list(data_root.glob("backup-auth-*"))
    # Covers moved.
    assert (data_root / "users" / "1" / "covers" / "x.jpg").is_file()
    # Admin user exists in the auth DB.
    settings = get_settings()
    auth = sqlite3.connect(settings.auth_database_file)
    try:
        row = auth.execute("SELECT email, is_admin FROM users WHERE id = 1").fetchone()
    finally:
        auth.close()
    assert row == ("patryk@example.com", 1)


def test_bootstrap_refuses_second_run(data_root: Path) -> None:
    _seed_legacy(data_root)
    assert cli.main(["users", "bootstrap", "--email", "a@example.com", "--name", "A"]) == 0
    # Second run refuses (admin already exists).
    rc = cli.main(["users", "bootstrap", "--email", "a@example.com", "--name", "A"])
    assert rc == 2


def test_default_origin_in_setup_link(data_root: Path, capsys) -> None:
    _seed_legacy(data_root)
    cli.main(["users", "bootstrap", "--email", "a@example.com", "--name", "A"])
    out = capsys.readouterr().out
    assert "http://127.0.0.1:5174/setup?token=" in out


def test_users_add_and_list(data_root: Path, capsys) -> None:
    _seed_legacy(data_root)
    cli.main(["users", "bootstrap", "--email", "admin@example.com", "--name", "Admin"])
    capsys.readouterr()
    assert cli.main(["users", "add", "--email", "second@example.com", "--name", "Second"]) == 0
    out = capsys.readouterr().out
    assert "/setup?token=" in out
    assert cli.main(["users", "list"]) == 0
    listing = capsys.readouterr().out
    assert "admin@example.com" in listing and "second@example.com" in listing


def test_series_check_all_users_touches_each_db(data_root: Path, monkeypatch, capsys) -> None:
    _seed_legacy(data_root)
    cli.main(["users", "bootstrap", "--email", "admin@example.com", "--name", "Admin"])
    cli.main(["users", "add", "--email", "second@example.com", "--name", "Second"])
    capsys.readouterr()

    # The second user has no library DB yet (created on first access); give them one so the
    # check visits a real file, and record which DBs the checker was pointed at.
    import asyncio

    from app.db import init_db

    asyncio.run(init_db(data_root / "users" / "2" / "shelfie.sqlite"))

    touched: list[str] = []

    async def fake_check(db_file=None, *, settings=None, user_id=1, user_data=None):
        from app.schemas.series import SeriesCheckResult

        touched.append(str(db_file))
        return SeriesCheckResult(checked=0, updated=0, series=[], notes="")

    monkeypatch.setattr("app.services.series_service.check_watched_series", fake_check)
    rc = cli.main(["series", "check", "--all-users"])
    assert rc == 0
    # Both users' DBs were visited.
    assert any("users\\1\\shelfie.sqlite" in t or "users/1/shelfie.sqlite" in t for t in touched)
    assert any("users\\2\\shelfie.sqlite" in t or "users/2/shelfie.sqlite" in t for t in touched)
