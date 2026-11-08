"""The book dataset: ``data/books.json`` -> database.

``data/books.json`` is the single source of truth for imported books (Google Books metadata plus
the user's reading data). ``build`` loads all of it, ``sample`` loads a random subset. Both reset
the library first, so running them twice never duplicates rows.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.db import SINGLE_USER_ID, connect, reset_library
from app.repositories import books as repo
from app.schemas.books import BookCreate

DATASET_VERSION = 1


class DatasetError(Exception):
    """The dataset file is missing or malformed."""


@dataclass(frozen=True)
class LoadReport:
    loaded: int
    skipped: int
    total_in_file: int


def read_dataset(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise DatasetError(f"{path} not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DatasetError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("books"), list):
        raise DatasetError(f"{path} must be an object with a 'books' list")
    version = payload.get("version")
    if version != DATASET_VERSION:
        raise DatasetError(f"{path} has version {version!r}, expected {DATASET_VERSION}")
    return list(payload["books"])


def parse_books(records: list[dict[str, Any]]) -> tuple[list[tuple[BookCreate, str | None]], int]:
    """Validate records into ``(BookCreate, added_at)`` pairs; return them and a skip count."""
    parsed: list[tuple[BookCreate, str | None]] = []
    skipped = 0
    for record in records:
        try:
            book = BookCreate.model_validate(record)
        except ValidationError:
            skipped += 1
            continue
        parsed.append((book, record.get("added_at")))
    return parsed, skipped


async def load_into_db(
    db_file: Path,
    dataset: Path,
    *,
    sample: int | None = None,
    seed: int | None = None,
) -> LoadReport:
    """Reset the library and load the dataset (or a random ``sample`` of it)."""
    records = read_dataset(dataset)
    parsed, skipped = parse_books(records)
    if sample is not None and sample < len(parsed):
        rng = random.Random(seed)  # nosec B311 - picking demo data, not security
        parsed = rng.sample(parsed, sample)

    await reset_library(db_file)
    conn = await connect(db_file)
    try:
        loaded = await repo.insert_many(conn, SINGLE_USER_ID, parsed)
    finally:
        await conn.close()
    return LoadReport(loaded=loaded, skipped=skipped, total_in_file=len(records))
