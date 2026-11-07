"""Daily backup: consistent SQLite copies, per-user folders, retention, partial cleanup."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.backup import run_backup


def _make_db(path: Path, rows: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("create table books (id integer primary key, title text)")
    con.executemany("insert into books(title) values (?)", [(f"b{i}",) for i in range(rows)])
    con.commit()
    con.close()


def _count(path: Path) -> int:
    con = sqlite3.connect(path)
    try:
        return con.execute("select count(*) from books").fetchone()[0]
    finally:
        con.close()


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    _make_db(d / "auth.sqlite", 2)
    _make_db(d / "users" / "1" / "shelfie.sqlite", 207)
    (d / "users" / "1" / "books.json").write_text("[]", encoding="utf-8")
    (d / "users" / "1" / "covers").mkdir()
    (d / "users" / "1" / "covers" / "a.jpg").write_bytes(b"x")
    _make_db(d / "users" / "2" / "shelfie.sqlite", 0)
    (d / "cache").mkdir()
    (d / "cache" / "big.json").write_text("{}", encoding="utf-8")
    return d


def test_backup_copies_every_user_and_auth(data_dir: Path, tmp_path: Path) -> None:
    result = run_backup(data_dir, tmp_path / "backups")
    assert result.users == 2
    assert _count(result.path / "auth.sqlite") == 2
    assert _count(result.path / "users" / "1" / "shelfie.sqlite") == 207
    assert (result.path / "users" / "1" / "books.json").is_file()
    assert (result.path / "users" / "1" / "covers" / "a.jpg").is_file()
    assert (result.path / "users" / "2" / "shelfie.sqlite").is_file()
    assert not (result.path / "cache").exists()  # caches are not personal


def test_backup_keeps_only_newest(data_dir: Path, tmp_path: Path) -> None:
    root = tmp_path / "backups"
    root.mkdir()
    for stamp in ("20260101-000000", "20260102-000000", "20260103-000000"):
        (root / stamp).mkdir()
    result = run_backup(data_dir, root, keep=2)
    names = sorted(p.name for p in root.iterdir())
    assert names == ["20260103-000000", result.path.name]
    assert len(result.removed) == 2


def test_backup_removes_partial_leftovers(data_dir: Path, tmp_path: Path) -> None:
    root = tmp_path / "backups"
    (root / "20260101-000000.partial").mkdir(parents=True)
    run_backup(data_dir, root)
    assert not any(p.name.endswith(".partial") for p in root.iterdir())
