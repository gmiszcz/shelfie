"""Re-check watched series for new/upcoming volumes (wave 5).

A thin CLI around :func:`app.services.series_service.check_watched_series`. It only
touches series with ``watch = 1`` so it never scans the whole library. Intended to be
scheduled daily by Kiro Crew cron (see docs/features/series-tracking.md); it does NOT
start a long-running scheduler of its own — one run, then exit.

    uv run --no-sync python -m scripts.check_series        # use the configured DB
    uv run --no-sync python -m scripts.check_series --db data/shelfie.sqlite
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.services import series_service  # noqa: E402


async def _run(db: Path | None) -> int:
    result = await series_service.check_watched_series(db_file=db)
    print(f"Checked {result.checked} watched series, updated {result.updated}.")
    for name in result.series:
        print(f"  - {name}")
    if result.notes:
        print(result.notes)
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help="SQLite file to check (default: the configured DB_PATH).",
    )
    args = parser.parse_args()
    db = args.db or get_settings().database_file
    sys.exit(asyncio.run(_run(db)))


if __name__ == "__main__":
    main()
