"""@tool functions for the library assistant.

The read tools query the local book database directly (stdlib ``sqlite3``, a worker
thread) for speed. The **write** tools never touch SQL: they go through the same
``app.services.books`` layer the HTTP API uses, so every add/update/delete obeys the
same validation, duplicate checks and schema rules. Because those services are async
and strands runs a tool synchronously in a worker thread, each write tool drives the
service with :func:`asyncio.run` over a fresh ``aiosqlite`` connection.

Human-in-the-loop safety
-------------------------
Destructive or wide-reaching writes are two-phase: ``delete_book`` and any bulk
update that would touch **more than three** books first return a
``{"needs_confirmation": True, ...}`` result describing exactly what would happen and
make **no** change. The agent must relay that summary to the user and only call the
tool again with ``confirm=True`` once the user has agreed in chat. See the system
prompt in ``config.yaml`` for the user-facing contract.
"""

from __future__ import annotations

import asyncio
import sqlite3
from contextlib import closing
from datetime import date
from typing import Any

from strands import tool

from app.config import get_settings
from app.db import SINGLE_USER_ID, connect
from app.repositories.books import row_to_book
from app.schemas.books import Book, BookCreate, BookInsights, BookUpdate
from app.services import books as books_service
from app.services import stats as stats_service
from app.userdata import current_database_file

MAX_LIMIT = 50

#: Bulk updates touching more than this many books need explicit confirmation.
BULK_CONFIRM_THRESHOLD = 3


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(current_database_file())
    conn.row_factory = sqlite3.Row
    return conn


def _all_books() -> list[Book]:
    with closing(_connect()) as conn:
        rows = conn.execute("SELECT * FROM books WHERE user_id = ?", (SINGLE_USER_ID,)).fetchall()
    return [row_to_book(row) for row in rows]


def _brief(book: Book) -> dict[str, Any]:
    return {
        "id": book.id,
        "title": book.title,
        "subtitle": book.subtitle,
        "authors": book.authors,
        "series": f"{book.series} #{book.volume}" if book.series and book.volume else book.series,
        "status": book.status.value,
        "stars": book.stars,
        "display_score": book.display_score,
        "finished_on": book.finished_on.isoformat() if book.finished_on else None,
        "shelves": book.shelves,
        "tags": book.tags,
    }


def _limit(value: int) -> int:
    return max(1, min(int(value or 10), MAX_LIMIT))


def _insights_text(book: Book) -> list[str]:
    """Every non-empty string inside a book's insights, for full-text search."""
    if book.insights is None:
        return []
    return [
        value
        for value in book.insights.model_dump().values()
        if isinstance(value, str) and value.strip()
    ]


def _haystack(book: Book) -> str:
    """All searchable text of a book, flattened and lower-cased (accents kept)."""
    parts: list[str] = [
        book.title,
        book.subtitle or "",
        book.series or "",
        book.volume or "",
        book.description or "",
        book.notes or "",
        book.review or "",
        book.quotes or "",
        book.publisher or "",
        book.language or "",
        book.format or "",
        book.edition or "",
        book.status.value,
        *book.authors,
        *book.translators,
        *book.categories,
        *book.shelves,
        *book.tags,
        *_insights_text(book),
    ]
    return " ".join(parts).lower()


def _score(book: Book) -> float | None:
    """The score the star filter buckets on: display_score if present, else stars."""
    return book.display_score if book.display_score is not None else book.stars


def _in_star_band(book: Book, band: int) -> bool:
    """True when ``book``'s score falls in whole-star bucket ``band`` (1..5).

    Bucket N is the half-open interval ``(N-0.5, N+0.5]`` with the two ends clamped:
    5 -> ``(4.5, 5.0]`` and 1 -> ``[0.0, 1.5]`` (see the wave-3 star-filter contract).
    Unscored books never match a band.
    """
    score = _score(book)
    if score is None:
        return False
    low = band - 0.5
    high = band + 0.5
    if band == 1:
        return 0.0 <= score <= 1.5
    if band == 5:
        return 4.5 < score <= 5.0
    return low < score <= high


def _run(coro: Any) -> Any:
    """Run an async service call to completion from a synchronous tool thread."""
    return asyncio.run(coro)


async def _with_conn(func: Any) -> Any:
    conn = await connect(current_database_file())
    try:
        return await func(conn)
    finally:
        await conn.close()


# --- read tools --------------------------------------------------------------------------


@tool
def search_library(query: str, stars: int = 0, limit: int = 10) -> dict[str, Any]:
    """Search the user's own library by free text, across every text field.

    Matches title, subtitle, authors, translators, series, publisher, language, format,
    edition, categories, shelves, tags, description, notes, review, quotes and the
    generated insights (summary, characters, plot, setting, themes, tone). Case-insensitive,
    accents kept. Use this first whenever the user mentions a book, author, series, a theme,
    a character or anything that might appear in a book's text.

    Args:
        query: Words to look for, e.g. "Droga Szamana", "Sanderson" or "Arlen".
        stars: Whole-star band 1-5 to keep only books of that rating; 0 means any.
            Band N keeps scores in (N-0.5, N+0.5], except 5 -> (4.5, 5.0] and 1 -> [0, 1.5].
            The score used is display_score when present, else the raw stars.
        limit: Maximum number of books to return (1-50).
    """
    needle = query.strip().lower()
    terms = [t for t in needle.split() if t]
    band = int(stars or 0)
    hits: list[Book] = []
    for book in _all_books():
        haystack = _haystack(book)
        if terms and not all(term in haystack for term in terms):
            continue
        if band and not _in_star_band(book, band):
            continue
        hits.append(book)
    hits.sort(key=lambda b: b.finished_on or date.min, reverse=True)
    return {"count": len(hits), "books": [_brief(b) for b in hits[: _limit(limit)]]}


@tool
def get_book_details(book_id: int) -> dict[str, Any]:
    """Return every stored field for one book (description, notes, dates, purchase data,
    and the generated insights).

    Args:
        book_id: The book id returned by search_library or list_books.
    """
    with closing(_connect()) as conn:
        row = conn.execute(
            "SELECT * FROM books WHERE user_id = ? AND id = ?", (SINGLE_USER_ID, int(book_id))
        ).fetchone()
    if row is None:
        return {"error": f"no book with id {book_id}"}
    return row_to_book(row).model_dump(mode="json")


@tool
def get_book(book_id: int) -> dict[str, Any]:
    """Return every stored field for one book: all catalogue metadata, reading data,
    description, notes, review, quotes and the generated ``insights`` object. Use this
    when the user wants the full detail of a specific book.

    Args:
        book_id: The book id returned by search_library or list_books.
    """
    return get_book_details(book_id)


@tool
def list_books(
    status: str = "",
    shelf: str = "",
    tag: str = "",
    year: int = 0,
    stars: int = 0,
    sort_by: str = "finished_on",
    limit: int = 25,
) -> dict[str, Any]:
    """List books from the library with optional filters.

    Args:
        status: One of want, reading, finished, abandoned. Empty for any.
        shelf: Shelf name, e.g. "Fantasy". Empty for any.
        tag: Tag name, e.g. "Magia". Empty for any.
        year: Only books finished in this calendar year. 0 for any year.
        stars: Whole-star band 1-5 to keep only books of that rating; 0 means any.
            Band N keeps scores in (N-0.5, N+0.5], except 5 -> (4.5, 5.0] and 1 -> [0, 1.5].
            The score used is display_score when present, else the raw stars.
        sort_by: "finished_on" (newest first), "stars" (best first) or "title".
        limit: Maximum number of books to return (1-50).
    """
    books = _all_books()
    if status:
        books = [b for b in books if b.status.value == status.strip().lower()]
    if shelf:
        books = [b for b in books if shelf.strip().lower() in (s.lower() for s in b.shelves)]
    if tag:
        books = [b for b in books if tag.strip().lower() in (t.lower() for t in b.tags)]
    if year:
        books = [b for b in books if b.finished_on and b.finished_on.year == int(year)]
    if stars:
        band = int(stars)
        books = [b for b in books if _in_star_band(b, band)]
    if sort_by == "stars":
        books.sort(key=lambda b: b.display_score or b.stars or 0, reverse=True)
    elif sort_by == "title":
        books.sort(key=lambda b: b.title.lower())
    else:
        books.sort(key=lambda b: b.finished_on or date.min, reverse=True)
    return {"count": len(books), "books": [_brief(b) for b in books[: _limit(limit)]]}


@tool
def reading_stats(date_from: str = "", date_to: str = "", group_by: str = "year") -> dict[str, Any]:
    """Reading statistics for finished books in a date range.

    Args:
        date_from: ISO date (YYYY-MM-DD) or empty for no lower bound.
        date_to: ISO date (YYYY-MM-DD) or empty for no upper bound.
        group_by: "year", "month", "shelf" or "tag".
    """
    try:
        start = date.fromisoformat(date_from) if date_from else None
        end = date.fromisoformat(date_to) if date_to else None
        by = stats_service.GroupBy(group_by)
    except ValueError as exc:
        return {"error": str(exc)}
    result = stats_service.build(_all_books(), start, end, by)
    return {
        "summary": result.summary.model_dump(),
        "groups": [b.model_dump() for b in result.buckets],
    }


@tool
def library_overview() -> dict[str, Any]:
    """Counts of the whole library: totals per status, shelf and tag, and the rated count."""
    books = _all_books()
    by_status: dict[str, int] = {}
    by_shelf: dict[str, int] = {}
    by_tag: dict[str, int] = {}
    for book in books:
        by_status[book.status.value] = by_status.get(book.status.value, 0) + 1
        for shelf in book.shelves:
            by_shelf[shelf] = by_shelf.get(shelf, 0) + 1
        for tag in book.tags:
            by_tag[tag] = by_tag.get(tag, 0) + 1
    return {
        "total": len(books),
        "rated": sum(1 for b in books if b.stars is not None),
        "by_status": by_status,
        "by_shelf": dict(sorted(by_shelf.items(), key=lambda kv: -kv[1])),
        "top_tags": dict(sorted(by_tag.items(), key=lambda kv: -kv[1])[:20]),
    }


# --- write tools (through app.services.books, never raw SQL) -----------------------------


def _coerce_date(value: str) -> date | None:
    """Parse an ISO date; blank/None -> None. Raises ValueError on a bad string."""
    if not value or not value.strip():
        return None
    return date.fromisoformat(value.strip())


@tool
def add_book(
    query: str = "",
    title: str = "",
    authors: str = "",
    status: str = "want",
    stars: float = 0.0,
    series: str = "",
    volume: str = "",
    published_date: str = "",
    started_on: str = "",
    finished_on: str = "",
    shelves: str = "",
    tags: str = "",
) -> dict[str, Any]:
    """Add a book to the library.

    Two ways to use it:

    - **From a search** (preferred): pass ``query`` (e.g. "Dune Frank Herbert"). The best
      Google Books match is looked up through the existing integration and added, enriched
      with that catalogue metadata (cover, publisher, ISBN, description). Any reading fields
      you also pass (status, stars, dates, shelves, tags) are applied on top of the match.
    - **Manually**: leave ``query`` empty and pass at least ``title``. Everything is taken
      from the fields you give.

    Args:
        query: Free-text search for Google Books (title + author). Empty to add manually.
        title: Book title (required when adding manually).
        authors: Author name(s), comma-separated, e.g. "Frank Herbert".
        status: Reading status: want, reading, finished or abandoned (default want).
        stars: Rating in half-star steps 0.5..5.0; 0 means unrated.
        series: Series name, if any.
        volume: Volume label within the series, if any.
        published_date: Publication date/year (manual add only; a search fills it in).
        started_on: ISO date the user started reading (YYYY-MM-DD).
        finished_on: ISO date the user finished (YYYY-MM-DD).
        shelves: Shelf name(s), comma-separated.
        tags: Tag name(s), comma-separated.
    """
    author_list = [a.strip() for a in authors.split(",") if a.strip()]
    shelf_list = [s.strip() for s in shelves.split(",") if s.strip()]
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        star_value = float(stars) if stars and float(stars) > 0 else None
        started = _coerce_date(started_on)
        finished = _coerce_date(finished_on)
    except ValueError as exc:
        return {"error": f"invalid field: {exc}"}

    fields: dict[str, Any] = {
        "status": status.strip().lower() or "want",
        "authors": author_list,
        "shelves": shelf_list,
        "tags": tag_list,
        "stars": star_value,
        "started_on": started,
        "finished_on": finished,
    }
    if series.strip():
        fields["series"] = series.strip()
    if volume.strip():
        fields["volume"] = volume.strip()

    matched: dict[str, Any] | None = None
    if query.strip():
        match = _run(_search_best_match(query.strip()))
        if match is None:
            return {
                "error": f"no Google Books match for {query!r}; add manually with title/authors"
            }
        matched = match.model_dump()
        # Search metadata is the base; the reading fields above win.
        base = {
            "title": match.title,
            "subtitle": match.subtitle,
            "authors": match.authors or author_list,
            "publisher": match.publisher,
            "published_date": match.published_date,
            "description": match.description,
            "page_count": match.page_count,
            "categories": match.categories,
            "language": match.language,
            "isbn_10": match.isbn_10,
            "isbn_13": match.isbn_13,
            "cover_url": match.cover_url,
            "google_volume_id": match.google_volume_id,
            "metadata_source": "google_books",
        }
        fields = {**base, **{k: v for k, v in fields.items() if v not in (None, [], "")}}
    else:
        if not title.strip():
            return {"error": "manual add needs a title (or pass query to search)"}
        fields["title"] = title.strip()
        if published_date.strip():
            fields["published_date"] = published_date.strip()
        fields["metadata_source"] = "manual"

    try:
        create = BookCreate(**fields)
    except Exception as exc:  # noqa: BLE001 - validation errors reported to the agent
        return {"error": f"invalid book: {exc}"}

    try:
        created: Book = _run(
            _with_conn(lambda c: books_service.add_book(c, SINGLE_USER_ID, create))
        )
    except books_service.DuplicateBookError:
        return {"error": "that book (same Google volume) is already in your library"}

    result: dict[str, Any] = {"ok": True, "added": _brief(created)}
    if matched is not None:
        result["matched_from_search"] = {
            "title": matched.get("title"),
            "authors": matched.get("authors"),
            "published_date": matched.get("published_date"),
        }
    return result


async def _search_best_match(query: str) -> Any:
    """Return the single best Google Books match for ``query`` (or None)."""
    from app.integrations.google_books import GoogleBooksClient

    settings = get_settings()
    client = GoogleBooksClient(
        base_url=settings.google_books_base_url,
        api_key=settings.google_books_api_key,
    )
    response = await books_service.search_external(client, query)
    return response.items[0] if response.items else None


@tool
def update_book(
    book_id: int = 0,
    book_ids: str = "",
    status: str = "",
    stars: float = -1.0,
    started_on: str = "",
    finished_on: str = "",
    shelves: str = "",
    tags: str = "",
    notes: str = "",
    review: str = "",
    confirm: bool = False,
) -> dict[str, Any]:
    """Update one or more books. Only the fields you pass are changed.

    Target either a single ``book_id`` or several at once with ``book_ids`` (a
    comma-separated list, e.g. "12,34,56"). Updating **more than three** books is a
    bulk change: the first call returns ``needs_confirmation`` with a summary and
    changes nothing; after the user agrees in chat, call again with ``confirm=True``.

    Args:
        book_id: The id of a single book to update.
        book_ids: Comma-separated ids for a multi-book update (overrides book_id).
        status: New status: want, reading, finished or abandoned. Empty = unchanged.
        stars: New rating in half-star steps 0.5..5.0. Leave at -1 to keep it; pass 0 to clear.
        started_on: ISO date started (YYYY-MM-DD). Empty = unchanged.
        finished_on: ISO date finished (YYYY-MM-DD). Empty = unchanged.
        shelves: Comma-separated shelves; replaces the whole list. Empty = unchanged.
        tags: Comma-separated tags; replaces the whole list. Empty = unchanged.
        notes: Free-text notes. Empty = unchanged.
        review: Free-text review. Empty = unchanged.
        confirm: Set True only after the user approved a bulk (>3 books) update.
    """
    ids = _parse_ids(book_ids, book_id)
    if not ids:
        return {"error": "no book id given (pass book_id or book_ids)"}

    changes: dict[str, Any] = {}
    if status.strip():
        changes["status"] = status.strip().lower()
    if stars is not None and stars >= 0:
        changes["stars"] = float(stars) if stars > 0 else None
    try:
        if started_on.strip():
            changes["started_on"] = _coerce_date(started_on)
        if finished_on.strip():
            changes["finished_on"] = _coerce_date(finished_on)
    except ValueError as exc:
        return {"error": f"invalid date: {exc}"}
    if shelves.strip():
        changes["shelves"] = [s.strip() for s in shelves.split(",") if s.strip()]
    if tags.strip():
        changes["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    if notes.strip():
        changes["notes"] = notes
    if review.strip():
        changes["review"] = review

    if not changes:
        return {"error": "nothing to update: pass at least one field to change"}

    try:
        update = BookUpdate(**changes)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"invalid update: {exc}"}

    if len(ids) > BULK_CONFIRM_THRESHOLD and not confirm:
        return {
            "needs_confirmation": True,
            "action": "update",
            "book_ids": ids,
            "count": len(ids),
            "changes": _describe_changes(changes),
            "message": (
                f"This would update {len(ids)} books. Confirm with the user, then call "
                "update_book again with confirm=True."
            ),
        }

    updated: list[dict[str, Any]] = []
    missing: list[int] = []
    for bid in ids:
        book = _run(
            _with_conn(lambda c, _b=bid: books_service.change_book(c, SINGLE_USER_ID, _b, update))
        )
        if book is None:
            missing.append(bid)
        else:
            updated.append(_brief(book))
    result: dict[str, Any] = {"ok": True, "updated_count": len(updated), "updated": updated}
    if missing:
        result["missing_ids"] = missing
    return result


@tool
def set_insights(
    book_id: int,
    summary: str = "",
    main_characters: str = "",
    main_plot: str = "",
    setting: str = "",
    themes: str = "",
    tone: str = "",
) -> dict[str, Any]:
    """Set or replace the structured insights of one book.

    Pass only the sections you want to fill; empty sections are stored as null. The
    insight ``source`` is recorded as "agent" and ``generated_at`` is stamped now.

    Args:
        book_id: The book id to set insights on.
        summary: One-paragraph summary of the book.
        main_characters: The main characters.
        main_plot: The central plot.
        setting: Where/when the book is set.
        themes: Its central themes.
        tone: The tone/mood of the book.
    """
    from datetime import datetime, timezone

    insights = BookInsights(
        summary=summary.strip() or None,
        main_characters=main_characters.strip() or None,
        main_plot=main_plot.strip() or None,
        setting=setting.strip() or None,
        themes=themes.strip() or None,
        tone=tone.strip() or None,
        generated_at=datetime.now(timezone.utc).isoformat(),
        source="agent",
    )
    update = BookUpdate(insights=insights)
    book = _run(
        _with_conn(lambda c: books_service.change_book(c, SINGLE_USER_ID, int(book_id), update))
    )
    if book is None:
        return {"error": f"no book with id {book_id}"}
    return {"ok": True, "book_id": book.id, "insights": insights.model_dump()}


@tool
def delete_book(book_id: int, confirm: bool = False) -> dict[str, Any]:
    """Delete one book from the library. **Always** needs confirmation.

    The first call returns ``needs_confirmation`` with the book's title and changes
    nothing. Relay that to the user; only once they agree in chat, call delete_book
    again with the same ``book_id`` and ``confirm=True``.

    Args:
        book_id: The id of the book to delete.
        confirm: Set True only after the user explicitly agreed to the deletion.
    """
    bid = int(book_id)
    book = _run(_with_conn(lambda c: books_service.get(c, SINGLE_USER_ID, bid)))
    if book is None:
        return {"error": f"no book with id {bid}"}

    if not confirm:
        authors = ", ".join(book.authors) if book.authors else "unknown author"
        return {
            "needs_confirmation": True,
            "action": "delete",
            "book_id": bid,
            "title": book.title,
            "authors": book.authors,
            "message": (
                f"This would permanently delete '{book.title}' by {authors} (id {bid}). "
                "Confirm with the user, then call delete_book again with confirm=True."
            ),
        }

    deleted = _run(_with_conn(lambda c: books_service.remove_book(c, SINGLE_USER_ID, bid)))
    if not deleted:
        return {"error": f"no book with id {bid}"}
    return {"ok": True, "deleted_id": bid, "title": book.title}


def _parse_ids(book_ids: str, book_id: int) -> list[int]:
    """Resolve a target id list from the ``book_ids`` CSV, falling back to ``book_id``."""
    ids: list[int] = []
    for part in book_ids.split(","):
        part = part.strip()
        if part:
            try:
                ids.append(int(part))
            except ValueError:
                continue
    if not ids and book_id:
        ids = [int(book_id)]
    # De-duplicate, keep order.
    seen: set[int] = set()
    unique: list[int] = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            unique.append(i)
    return unique


def _describe_changes(changes: dict[str, Any]) -> dict[str, Any]:
    """A JSON-safe echo of a pending update's fields, for the confirmation summary."""
    out: dict[str, Any] = {}
    for key, value in changes.items():
        out[key] = value.isoformat() if isinstance(value, date) else value
    return out


# --- series / favourites / waiting-list tools (wave 5) -----------------------------------
#
# These let the library assistant answer questions about series (owned/read/missing
# volumes, next expected release), toggle the watch flag, run a lookup now, manage
# favourites and put an upcoming book on the waiting list. They go through
# app.services.series_service (same code the HTTP API uses), driven from the sync tool
# thread with asyncio.run over a fresh connection — exactly like the write tools above.


def _series_brief(summary: Any) -> dict[str, Any]:
    """A compact JSON view of a SeriesSummary for the agent."""
    return {
        "series_key": summary.series_key,
        "name": summary.name,
        "author": summary.author,
        "aliases": summary.aliases,
        "section": summary.section,
        "owned": summary.owned_count,
        "read": summary.read_count,
        "unread_owned": summary.unread_owned_count,
        "total_known": summary.total_known,
        "missing_volumes": [
            {"number": m.number, "title": m.title, "published_date": m.published_date}
            for m in summary.missing_volumes
        ],
        "owned_volumes": [
            {
                "book_id": o.book_id,
                "volume": o.volume,
                "title": o.title,
                "read": o.read,
                "status": o.status,
            }
            for o in summary.owned_volumes
        ],
        "watch": summary.watch,
        "next_expected": summary.next_expected.model_dump() if summary.next_expected else None,
        "last_checked": summary.last_checked,
    }


@tool
def list_series() -> dict[str, Any]:
    """List every series in the user's library with reading progress.

    For each series: owned volume count, read count, unread-owned count, total known
    volumes, which section it is in (in_progress / complete / owned), whether it is
    watched, and the missing volumes. Use this for "what series am I in the middle of",
    "which series are complete" or "what am I missing".
    """
    from app.services import series_service

    summaries = _run(_with_conn(lambda c: series_service.list_series(c, SINGLE_USER_ID)))
    return {"count": len(summaries), "series": [_series_brief(s) for s in summaries]}


@tool
def get_series(name: str) -> dict[str, Any]:
    """Return one series by name (owned, read and missing volumes, next expected release).

    Matches the name against every series' canonical name AND its stored aliases, so a
    series known under several names/editions (e.g. "King's Dark Tidings" / "Kroniki
    Mroku") is found by any of them. Use this whenever the user asks about a specific
    series: whether they read it, what they own, what is missing, or when the next
    volume is due.

    Args:
        name: The series name (any language/edition alias), e.g. "Kroniki Mroku".
    """
    from app.services import series_service

    summary = _run(_with_conn(lambda c: series_service.get_series(c, SINGLE_USER_ID, name)))
    if summary is None:
        return {"error": f"no series matching {name!r} in the library"}
    return _series_brief(summary)


@tool
def set_series_watch(name: str, on: bool = True) -> dict[str, Any]:
    """Turn the 'watch for new volumes' flag on or off for a series.

    Only watched series are re-checked for new releases by the periodic checker, so the
    agent never scans the whole library. Resolve the series by name/alias first.

    Args:
        name: The series name (any alias).
        on: True to watch, False to stop watching.
    """
    from app.services import series_service

    summary = _run(
        _with_conn(lambda c: series_service.set_watch(c, SINGLE_USER_ID, name, watch=bool(on)))
    )
    if summary is None:
        return {"error": f"no series matching {name!r}"}
    return {"ok": True, "series": summary.name, "watch": summary.watch}


@tool
def refresh_series(name: str) -> dict[str, Any]:
    """Run the external lookup for one series NOW (Google Books PL+EN, OpenLibrary).

    Refreshes the cached known volumes, total and next-expected release. Use when the
    user asks to check a specific series for new or missing volumes right away, or asks
    whether all volumes of a series are out (and when the last one).

    Args:
        name: The series name (any alias).
    """
    from app.services import series_service

    summary = _run(_with_conn(lambda c: series_service.refresh_series(c, SINGLE_USER_ID, name)))
    if summary is None:
        return {"error": f"no series matching {name!r}"}
    return _series_brief(summary)


@tool
def list_favourites(limit: int = 50) -> dict[str, Any]:
    """List the user's favourite books (the ones flagged with the heart).

    Args:
        limit: Maximum number of books to return (1-50).
    """
    favourites = [b for b in _all_books() if getattr(b, "favourite", False)]
    favourites.sort(key=lambda b: b.title.lower())
    return {"count": len(favourites), "books": [_brief(b) for b in favourites[: _limit(limit)]]}


@tool
def set_favourite(book: str = "", book_id: int = 0, on: bool = True) -> dict[str, Any]:
    """Mark a book as a favourite, or remove the favourite flag.

    Pass either ``book_id`` (preferred — resolve it with search_library first) or a
    ``book`` title/search phrase, which is matched against the library.

    Args:
        book: A title or search phrase to find the book (used when no book_id is given).
        book_id: The exact book id (overrides ``book``).
        on: True to favourite, False to un-favourite.
    """
    target_id = int(book_id) if book_id else 0
    if not target_id and book.strip():
        needle = book.strip().lower()
        terms = [t for t in needle.split() if t]
        hits = [b for b in _all_books() if all(t in _haystack(b) for t in terms)]
        if not hits:
            return {"error": f"no book matching {book!r}"}
        if len(hits) > 1:
            return {
                "error": "several books match; call with a specific book_id",
                "candidates": [_brief(b) for b in hits[:5]],
            }
        target_id = hits[0].id
    if not target_id:
        return {"error": "pass book_id or a book title"}

    update = BookUpdate(favourite=bool(on))
    updated = _run(
        _with_conn(lambda c: books_service.change_book(c, SINGLE_USER_ID, target_id, update))
    )
    if updated is None:
        return {"error": f"no book with id {target_id}"}
    return {"ok": True, "book_id": updated.id, "title": updated.title, "favourite": bool(on)}


@tool
def list_waiting_list() -> dict[str, Any]:
    """List the waiting list: not-yet-owned upcoming books (watched series + manual adds)."""
    from app.services import series_service

    items = _run(_with_conn(lambda c: series_service.list_expected(c, SINGLE_USER_ID)))
    return {
        "count": len(items),
        "expected": [i.model_dump() for i in items],
    }


@tool
def add_expected_book(
    title: str,
    author: str = "",
    series: str = "",
    volume: str = "",
    expected_date: str = "",
    source_url: str = "",
) -> dict[str, Any]:
    """Put a not-yet-owned upcoming book on the waiting list.

    Use when the user wants to be reminded of a book that is coming out and is not in
    the library yet (an announced next volume, a pre-order). It is NOT added to the
    library — it lives on the Series tab's waiting list until the user owns it.

    Args:
        title: The upcoming book's title (required).
        author: The author.
        series: Series name, if it belongs to one.
        volume: Volume label within the series.
        expected_date: Expected release date (free text or ISO).
        source_url: A link to the announcement/source.
    """
    from app.schemas.series import ExpectedBookCreate
    from app.services import series_service

    if not title.strip():
        return {"error": "a title is required"}
    data = ExpectedBookCreate(
        title=title.strip(),
        author=author.strip(),
        series_name=series.strip() or None,
        volume=volume.strip() or None,
        expected_date=expected_date.strip() or None,
        source_url=source_url.strip() or None,
        source="agent",
        confidence="user",
    )
    created = _run(_with_conn(lambda c: series_service.add_expected(c, SINGLE_USER_ID, data)))
    return {"ok": True, "added": created.model_dump()}


# --- series editing tools (wave 5) -------------------------------------------------------
#
# These let the library assistant CHANGE a series when the user asks ("dodaj X do serii Y
# jako tom 3", "zmień nazwę serii", "połącz serie"). They go through
# app.services.series_service, which updates the DB and mirrors every book's series/volume
# into data/books.json, so the two stores never drift. Reading data is never touched.


def _resolve_book_id(ref: str, book_id: int) -> tuple[int | None, dict[str, Any] | None]:
    """Resolve a book from an explicit id or a title/search phrase.

    Returns ``(book_id, None)`` on a unique hit, or ``(None, error_dict)`` when nothing
    matched or several books matched (the error carries candidates for the agent).
    """
    if book_id:
        return int(book_id), None
    needle = (ref or "").strip().lower()
    if not needle:
        return None, {"error": "pass a book title/id to identify the book"}
    terms = [t for t in needle.split() if t]
    hits = [b for b in _all_books() if all(t in _haystack(b) for t in terms)]
    if not hits:
        return None, {"error": f"no book matching {ref!r}"}
    if len(hits) > 1:
        return None, {
            "error": "several books match; call with a specific book_id",
            "candidates": [_brief(b) for b in hits[:5]],
        }
    return hits[0].id, None


@tool
def update_series(
    name_or_alias: str,
    new_name: str = "",
    aliases: str = "",
    author: str = "",
    total_volumes: int = -1,
    notes: str = "",
) -> dict[str, Any]:
    """Edit a series' details when the user asks to change them.

    Resolve the series by any of its names/aliases. ``new_name`` renames the series on
    EVERY member book (the old name is kept as an alias). ``aliases`` REPLACES the alias
    list (comma-separated). Only the arguments you pass are changed.

    Args:
        name_or_alias: The series to edit, by any current name or alias.
        new_name: Rename the series across all its books (optional).
        aliases: Comma-separated alias list that REPLACES the current aliases (optional).
        author: New author for the series (optional).
        total_volumes: New total known volume count; leave at -1 to keep it.
        notes: New notes text (optional).
    """
    from app.services import series_service

    async def run(conn: Any) -> dict[str, Any]:
        summary = await series_service.get_series(conn, SINGLE_USER_ID, name_or_alias)
        if summary is None:
            return {"error": f"no series matching {name_or_alias!r}"}
        key = summary.series_key
        if new_name.strip() and new_name.strip() != summary.name:
            renamed = await series_service.rename_series(
                conn, SINGLE_USER_ID, key, new_name.strip()
            )
            key = renamed.series_key if renamed else key
        alias_list = (
            [a.strip() for a in aliases.split(",") if a.strip()] if aliases.strip() else None
        )
        updated = await series_service.update_series(
            conn,
            SINGLE_USER_ID,
            key,
            aliases=alias_list,
            author=author.strip() or None,
            total_volumes=total_volumes
            if total_volumes is not None and total_volumes >= 0
            else None,
            notes=notes if notes.strip() else None,
        )
        return _series_brief(updated) if updated else {"error": "series not found after update"}

    return _run(_with_conn(run))


@tool
def add_book_to_series(
    book: str = "",
    series: str = "",
    volume: str = "",
    book_id: int = 0,
) -> dict[str, Any]:
    """Add a library book to a series (e.g. "dodaj X do serii Y jako tom 3").

    Sets the book's ``series`` to the series' name and its ``volume``. Resolve the book
    with a title or an explicit ``book_id``. Works for an existing series or a brand new
    series name.

    Args:
        book: Book title / search phrase to identify it (or use book_id).
        series: The series name (existing or new) to add the book to.
        volume: The volume label within the series (e.g. "3").
        book_id: The exact book id (overrides ``book``).
    """
    from app.services import series_service

    if not series.strip():
        return {"error": "a series name is required"}
    resolved, err = _resolve_book_id(book, book_id)
    if err is not None:
        return err
    assert resolved is not None  # nosec B101 - narrowed by the err guard above

    async def run(conn: Any) -> dict[str, Any]:
        summary = await series_service.add_book_to_series(
            conn, SINGLE_USER_ID, series.strip(), int(resolved), volume=volume.strip() or None
        )
        return _series_brief(summary) if summary else {"error": "book not found"}

    return _run(_with_conn(run))


@tool
def remove_book_from_series(book: str = "", series: str = "", book_id: int = 0) -> dict[str, Any]:
    """Remove a book from a series (clears its series and volume).

    Args:
        book: Book title / search phrase to identify it (or use book_id).
        series: The series the book is currently in.
        book_id: The exact book id (overrides ``book``).
    """
    from app.services import series_service

    if not series.strip():
        return {"error": "a series name is required"}
    resolved, err = _resolve_book_id(book, book_id)
    if err is not None:
        return err
    assert resolved is not None  # nosec B101 - narrowed by the err guard above

    async def run(conn: Any) -> dict[str, Any]:
        summary = await series_service.remove_book_from_series(
            conn, SINGLE_USER_ID, series.strip(), int(resolved)
        )
        return _series_brief(summary) if summary else {"error": "series or book not found"}

    return _run(_with_conn(run))


@tool
def set_book_volume(
    book: str = "", series: str = "", volume: str = "", book_id: int = 0
) -> dict[str, Any]:
    """Change a book's volume number within its series.

    Args:
        book: Book title / search phrase to identify it (or use book_id).
        series: The series the book belongs to.
        volume: The new volume label (empty clears it).
        book_id: The exact book id (overrides ``book``).
    """
    from app.services import series_service

    if not series.strip():
        return {"error": "a series name is required"}
    resolved, err = _resolve_book_id(book, book_id)
    if err is not None:
        return err
    assert resolved is not None  # nosec B101 - narrowed by the err guard above

    async def run(conn: Any) -> dict[str, Any]:
        summary = await series_service.set_book_volume(
            conn, SINGLE_USER_ID, series.strip(), int(resolved), volume=volume.strip() or None
        )
        return _series_brief(summary) if summary else {"error": "series or book not found"}

    return _run(_with_conn(run))


@tool
def merge_series(a: str, b: str) -> dict[str, Any]:
    """Merge two series into one (e.g. "połącz serie A i B").

    Every book of series ``b`` is moved to series ``a``; ``b``'s names become aliases of
    ``a``. Both are resolved by any of their names/aliases.

    Args:
        a: The series to keep (the merge target).
        b: The series to merge into ``a``.
    """
    from app.services import series_service

    async def run(conn: Any) -> dict[str, Any]:
        summary = await series_service.merge_series(conn, SINGLE_USER_ID, a, b)
        return _series_brief(summary) if summary else {"error": "one of the series was not found"}

    return _run(_with_conn(run))
