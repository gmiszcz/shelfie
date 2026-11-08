"""Load the book dataset (data/books.json) into the database.

    python -m scripts.dbase build            # every book from the dataset
    python -m scripts.dbase sample [-n 40]   # a random subset (different each run)

Both reset the library first, then recompute the rating scores. The dataset is JSON; this
script never reads any other format.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.db import SINGLE_USER_ID, connect  # noqa: E402
from app.services import dataset, ratings  # noqa: E402


async def run(mode: str, count: int, seed: int | None) -> int:
    settings = get_settings()
    try:
        report = await dataset.load_into_db(
            settings.database_file,
            settings.dataset_file,
            sample=count if mode == "sample" else None,
            seed=seed,
        )
    except dataset.DatasetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    conn = await connect(settings.database_file)
    try:
        scores = await ratings.recompute(conn, SINGLE_USER_ID)
    finally:
        await conn.close()

    label = "Built" if mode == "build" else "Sampled"
    print(
        f"{label} library: {report.loaded} books loaded from {settings.dataset_file.name} "
        f"({report.total_in_file} in file, {report.skipped} invalid skipped); "
        f"{len(scores)} rated books scored."
    )
    print(f"Database: {settings.database_file}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("build", help="load every book from the dataset")
    sample = sub.add_parser("sample", help="load a random subset of the dataset")
    sample.add_argument("-n", "--count", type=int, default=40, help="books to load (default 40)")
    sample.add_argument("--seed", type=int, default=None, help="fix the random pick")
    args = parser.parse_args()
    count = getattr(args, "count", 0)
    sys.exit(asyncio.run(run(args.mode, count, getattr(args, "seed", None))))


if __name__ == "__main__":
    main()
