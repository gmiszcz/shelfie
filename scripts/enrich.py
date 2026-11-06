"""Fill structured ``insights`` on the book dataset, book by book.

    python -m scripts.enrich                       # fill missing insights in data/books.json
    python -m scripts.enrich --path copy.json      # work on a different file
    python -m scripts.enrich --limit 3             # only the first 3 that need it
    python -m scripts.enrich --force               # redo every book, even ones with insights
    python -m scripts.enrich --fill-description    # also ask the model for a missing description

The file is written back atomically (temp file + replace) after EVERY book, so a crash or
Ctrl-C keeps all progress so far. The model call is best-effort: a book that fails to
enrich keeps ``insights: null`` and the walk moves on.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.schemas.books import BookCreate  # noqa: E402
from app.services import enrichment  # noqa: E402


def _needs_insights(record: dict[str, Any], *, force: bool) -> bool:
    if force:
        return True
    insights = record.get("insights")
    if not isinstance(insights, dict):
        return True
    return not any(
        isinstance(v, str) and v.strip()
        for k, v in insights.items()
        if k not in {"generated_at", "source"}
    )


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON to a temp file in the same directory, then replace the target."""
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


async def run(
    path: Path,
    *,
    force: bool,
    limit: int | None,
    fill_description: bool,
) -> int:
    settings = get_settings()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {path}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(payload, dict) or not isinstance(payload.get("books"), list):
        print(f"error: {path} must be an object with a 'books' list", file=sys.stderr)
        return 1

    books: list[dict[str, Any]] = payload["books"]
    done = 0
    failed = 0
    for index, record in enumerate(books):
        if limit is not None and done >= limit:
            break
        if not _needs_insights(record, force=force):
            continue
        try:
            book = BookCreate.model_validate(record)
        except Exception:  # noqa: BLE001 - skip unparseable rows, keep going
            print(f"  [{index}] skipped (invalid record)")
            continue

        insights = await enrichment.generate_insights(book, settings=settings)
        title = record.get("title", "?")
        if insights is None:
            failed += 1
            print(f"  [{index}] {title!r}: FAILED (insights left null)")
            continue

        record["insights"] = insights.model_dump()
        if fill_description and not (record.get("description") or "").strip():
            record["description"] = insights.summary

        _atomic_write(path, payload)  # persist after every book
        done += 1
        print(f"  [{index}] {title!r}: enriched")

    print(f"\nDone: {done} enriched, {failed} failed. File: {path}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--path",
        type=Path,
        default=None,
        help="dataset file to enrich (default: the configured data/books.json)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="redo every book, even ones that already have insights",
    )
    parser.add_argument("--limit", type=int, default=None, help="only enrich this many books")
    parser.add_argument(
        "--fill-description",
        action="store_true",
        help="also set a missing description from the generated summary",
    )
    args = parser.parse_args()
    path = args.path or get_settings().dataset_file
    sys.exit(
        asyncio.run(
            run(
                path,
                force=args.force,
                limit=args.limit,
                fill_description=args.fill_description,
            )
        )
    )


if __name__ == "__main__":
    main()
