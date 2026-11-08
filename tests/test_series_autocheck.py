"""Automatic watched-series check when the app opens (stale > 24 h only)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.db import SINGLE_USER_ID, connect, init_db
from app.repositories import series as repo
from app.schemas.series import SeriesInfo
from app.services import series_service
from app.userdata import UserData


async def _seed(db: Path, *, watch: bool, last_checked: str | None) -> None:
    await init_db(db)
    conn = await connect(db)
    try:
        info = SeriesInfo(series_key="kdt", display_name="King's Dark Tidings", watch=watch)
        await repo.upsert_info(conn, SINGLE_USER_ID, info)
        await conn.execute("UPDATE series_info SET last_checked = ?", (last_checked,))
        await conn.commit()
    finally:
        await conn.close()


def _ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


@pytest.mark.parametrize(
    ("watch", "last_checked", "stale"),
    [
        (True, None, True),
        (True, "OLD", True),
        (True, "FRESH", False),
        (False, None, False),
    ],
)
async def test_stale_rules(
    tmp_path: Path, watch: bool, last_checked: str | None, stale: bool
) -> None:
    ts = {"OLD": _ago(30), "FRESH": _ago(2)}.get(last_checked or "", last_checked)
    db = tmp_path / "shelfie.sqlite"
    await _seed(db, watch=watch, last_checked=ts)
    assert await series_service.watched_series_stale(db) is stale


async def test_auto_check_runs_only_when_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Path] = []

    async def fake_check(*, db_file: Path, settings: object, user_id: int) -> object:
        calls.append(db_file)

        class R:
            checked = 1
            updated = 1

        return R()

    monkeypatch.setattr(series_service, "check_watched_series", fake_check)
    ud = UserData.for_user(tmp_path, 1)
    ud.ensure_dirs()

    await _seed(ud.database_file, watch=True, last_checked=_ago(2))
    assert await series_service.auto_check_if_stale(ud) is False
    assert calls == []

    await _seed(ud.database_file, watch=True, last_checked=_ago(30))
    assert await series_service.auto_check_if_stale(ud) is True
    assert calls == [ud.database_file]


async def test_auto_check_with_no_library_does_nothing(tmp_path: Path) -> None:
    ud = UserData.for_user(tmp_path, 2)
    assert await series_service.auto_check_if_stale(ud) is False
