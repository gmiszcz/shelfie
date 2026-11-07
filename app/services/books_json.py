"""Keep ``data/books.json`` in sync with series/volume edits made to the database.

The Series-edit feature (wave 5) changes two catalogue fields on member books —
``series`` and ``volume`` — when a book is added to, removed from, re-volumed in or
renamed across a series. Those two stores (the SQLite DB the backend reads and the
``data/books.json`` dataset that is the source of truth) must never drift, so every
such change is mirrored into the JSON by this module.

It reuses the matching rules of :mod:`scripts._dataio`: a JSON record is found for a
book by identity — Google volume id, then ISBN-13/10, then external id, then
title+authors — and only when a single unambiguous record matches. Writes are atomic
(temp file + ``os.replace``). Reading data (dates, stars, shelves, tags, notes, the
rating ``comparisons``) is never touched: only ``series`` and ``volume`` are written.

This module does file IO only and holds no DB connection; the service layer passes it
the book's identity fields and the new ``series`` / ``volume`` values. When the dataset
file does not exist (e.g. a test DB with no JSON beside it) it is a silent no-op, so the
API keeps working without a dataset.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.config import get_settings
from scripts import _dataio

logger = logging.getLogger(__name__)

# The only fields this mirror is ever allowed to write to a JSON record.
_SYNCABLE = ("series", "volume")


def _dataset_file() -> Path:
    return get_settings().dataset_file


def _norm(text: str | None) -> str:
    return (text or "").strip().casefold()


def _authors_key(authors: Any) -> str:
    if not isinstance(authors, list):
        return ""
    return "|".join(sorted(_norm(a) for a in authors if a))


def _match_record(books: list[dict[str, Any]], identity: dict[str, Any]) -> dict[str, Any] | None:
    """Find the single JSON record for a book by identity (strongest key first).

    Mirrors :func:`scripts._dataio.match_db_id` but returns the record dict rather than
    a DB id. Returns ``None`` when no unambiguous match exists.
    """

    def _single(key_name: str, wanted: Any) -> dict[str, Any] | None:
        if not wanted:
            return None
        hits = [b for b in books if b.get(key_name) and b.get(key_name) == wanted]
        return hits[0] if len(hits) == 1 else None

    for key in ("google_volume_id", "isbn_13", "isbn_10", "external_id"):
        hit = _single(key, identity.get(key))
        if hit is not None:
            return hit

    title_key = _norm(identity.get("title"))
    authors_key = _authors_key(identity.get("authors"))
    if title_key:
        hits = [
            b
            for b in books
            if _norm(b.get("title")) == title_key and _authors_key(b.get("authors")) == authors_key
        ]
        if len(hits) == 1:
            return hits[0]
    return None


def sync_book_series(
    identity: dict[str, Any],
    *,
    series: str | None,
    volume: str | None,
    dataset_file: Path | None = None,
) -> bool:
    """Write ``series`` / ``volume`` for one book into ``data/books.json`` atomically.

    ``identity`` carries the book's matching fields (``google_volume_id``, ``isbn_13``,
    ``isbn_10``, ``external_id``, ``title``, ``authors``). ``series`` / ``volume`` are
    the new values (``None`` clears the field, matching a book leaving a series).

    Returns ``True`` when a record was found and written, ``False`` when the dataset is
    absent or no unambiguous record matched (logged, never raised — the DB is already
    updated and must stay the source of truth for the request).
    """
    path = dataset_file or _dataset_file()
    if not path.is_file():
        logger.info("books.json mirror skipped: no dataset at %s", path)
        return False
    try:
        payload = _dataio.load_dataset(path)
    except (ValueError, OSError) as exc:
        logger.warning("books.json mirror could not read %s: %s", path, exc)
        return False

    books: list[dict[str, Any]] = payload["books"]
    record = _match_record(books, identity)
    if record is None:
        logger.warning(
            "books.json mirror: no unambiguous record for %r; JSON left unchanged",
            identity.get("title"),
        )
        return False

    changed = False
    for field, value in (("series", series), ("volume", volume)):
        if field not in _SYNCABLE:
            continue
        if record.get(field) != value:
            record[field] = value
            changed = True

    if changed:
        _dataio.atomic_write_json(path, payload)
    return True
