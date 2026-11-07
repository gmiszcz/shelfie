"""Series service: orchestrates the repository, computation and external lookups (wave 5).

This is the layer the HTTP API and the agent tools call. It never writes SQL directly
and keeps the pure computation in :mod:`app.services.series`.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import aiosqlite

from app.config import Settings, get_settings
from app.db import SINGLE_USER_ID, connect
from app.integrations import series_lookup
from app.integrations.google_books import GoogleBooksClient
from app.repositories import books as books_repo
from app.repositories import series as repo
from app.schemas.books import Book, BookUpdate
from app.schemas.series import (
    AlertsResponse,
    ExpectedBook,
    ExpectedBookCreate,
    NextExpected,
    SeriesAlert,
    SeriesCheckResult,
    SeriesInfo,
    SeriesSummary,
)
from app.services import books_json
from app.services import series as compute
from app.userdata import UserData, get_current_user_data

logger = logging.getLogger(__name__)

# Known cross-language / cross-edition series name aliases, seeded on first list so a
# query in any of these names resolves to the one canonical series. The user can add
# more via set_aliases / the agent. Keyed by canonical series name.
DEFAULT_ALIASES: dict[str, list[str]] = {
    "King's Dark Tidings": ["Kroniki Mroku"],
}


def _client(settings: Settings | None = None) -> GoogleBooksClient:
    settings = settings or get_settings()
    return GoogleBooksClient(
        base_url=settings.google_books_base_url,
        api_key=settings.google_books_api_key,
    )


async def _seed_default_aliases(conn: aiosqlite.Connection, user_id: int) -> None:
    """Ensure the built-in aliases exist on their series' cached row (idempotent)."""
    for name, aliases in DEFAULT_ALIASES.items():
        key = compute.series_key(name)
        existing = await repo.get_info(conn, user_id, key)
        if existing is not None and set(aliases).issubset(set(existing.aliases)):
            continue
        info = existing or SeriesInfo(series_key=key, display_name=name)
        info.aliases = sorted(set(info.aliases) | set(aliases))
        if not info.display_name:
            info.display_name = name
        await repo.upsert_info(conn, user_id, info)


async def list_series(conn: aiosqlite.Connection, user_id: int) -> list[SeriesSummary]:
    await _seed_default_aliases(conn, user_id)
    books = await books_repo.list_books(conn, user_id)
    infos = await repo.list_infos(conn, user_id)
    return compute.compute_series(books, infos)


async def get_series(
    conn: aiosqlite.Connection, user_id: int, series_key: str
) -> SeriesSummary | None:
    """Find one series by its canonical key OR any of its (aliased) names."""
    infos = await repo.list_infos(conn, user_id)
    canonical = compute.resolve_series_key(series_key, infos)
    summaries = await list_series(conn, user_id)
    for summary in summaries:
        if summary.series_key == canonical or summary.series_key == compute.series_key(series_key):
            return summary
    # Also try a direct name match against each summary's name / aliases.
    wanted = compute.series_key(series_key)
    for summary in summaries:
        names = [summary.name, *summary.aliases]
        if any(compute.series_key(n) == wanted for n in names):
            return summary
    return None


async def set_watch(
    conn: aiosqlite.Connection, user_id: int, series_key: str, *, watch: bool
) -> SeriesSummary | None:
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    info = await repo.get_info(conn, user_id, summary.series_key) or SeriesInfo(
        series_key=summary.series_key,
        display_name=summary.name,
        author=summary.author,
    )
    info.watch = watch
    # Turning watch ON schedules a web release-research run; flag it so the UI can show a
    # "Checking new volumes…" spinner while the background task runs. The caller (the route)
    # kicks off research_series_releases() after this returns.
    info.checking = watch
    await repo.upsert_info(conn, user_id, info)
    return await get_series(conn, user_id, summary.series_key)


async def mark_checking(
    conn: aiosqlite.Connection, user_id: int, series_key: str, *, checking: bool
) -> None:
    """Set/clear the transient 'checking' flag on a series' cached row."""
    summary = await get_series(conn, user_id, series_key)
    key = summary.series_key if summary else compute.series_key(series_key)
    info = await repo.get_info(conn, user_id, key)
    if info is None:
        return
    info.checking = checking
    await repo.upsert_info(conn, user_id, info)


async def refresh_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    *,
    settings: Settings | None = None,
) -> SeriesSummary | None:
    """Run the web release-research step for one series now and store the result.

    This is the same step the watch toggle and ``POST /api/series/check`` use. It never
    calls Google Books — see :mod:`app.agent.series_research`.
    """
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    await research_series_releases(user_id, summary.series_key, settings=settings, conn=conn)
    return await get_series(conn, user_id, summary.series_key)


async def _lookup_and_cache(
    conn: aiosqlite.Connection,
    user_id: int,
    summary: SeriesSummary,
    *,
    settings: Settings | None = None,
    find_next: bool = False,
) -> SeriesInfo:
    google = _client(settings)
    known, total, status = await series_lookup.lookup_series(summary.name, summary.author, google)
    owned_numbers = {o.volume for o in summary.owned_volumes if o.volume is not None}
    next_expected = None
    if find_next:
        next_expected = await series_lookup.find_next_release(
            summary.name, summary.author, owned_numbers, google
        )

    existing = await repo.get_info(conn, user_id, summary.series_key)
    info = existing or SeriesInfo(series_key=summary.series_key)
    info.display_name = summary.name
    info.author = summary.author
    # Keep previously cached volumes when this run could not reach Google and found
    # nothing new — never wipe a good cache because of a 429.
    if known or not existing or not existing.known_volumes:
        info.known_volumes = known or (existing.known_volumes if existing else [])
    if total is not None:
        info.total_known = total
    if next_expected is not None:
        info.next_expected = next_expected
    info.notes = status.note()
    return await repo.upsert_info(conn, user_id, info, touch_checked=True)


async def check_watched_series(
    db_file: Path | None = None,
    *,
    settings: Settings | None = None,
    user_id: int = SINGLE_USER_ID,
    user_data: UserData | None = None,
) -> SeriesCheckResult:
    """Run the web release-research step for every watched series of ONE user.

    Opens its own connection so it can run detached (the ``POST /api/series/check``
    endpoint or the CLI). The user's library is ``db_file`` when given, else
    ``user_data.database_file``, else the current context's DB. Watched series only. Each
    series is researched on the open web (Polish + original/English editions) and the
    result stored. Never calls Google Books.
    """
    settings = settings or get_settings()
    if db_file is None:
        data = user_data or get_current_user_data()
        db_file = data.database_file
    conn = await connect(db_file)
    updated_names: list[str] = []
    checked = 0
    try:
        watched = await repo.list_watched(conn, user_id=user_id)
        for info in watched:
            checked += 1
            try:
                summary = await research_series_releases(
                    user_id, info.series_key, settings=settings, conn=conn
                )
                if summary is not None:
                    updated_names.append(summary.name)
            except Exception:  # noqa: BLE001 - one series failing must not abort the run
                logger.exception("series research failed for %s", info.display_name)
    finally:
        await conn.close()
    return SeriesCheckResult(
        checked=checked,
        updated=len(updated_names),
        series=updated_names,
        notes="Source: web release research (Polish + original editions). Google Books not used.",
    )


def _next_expected_from_edition(edition: Any) -> NextExpected | None:
    """Convert a research EditionResult into a NextExpected, or None when all-unknown."""
    if edition is None:
        return None
    if not edition.title and not edition.date and edition.status == "unknown":
        return None
    return NextExpected(
        title=edition.title,
        date=edition.date,
        source_url=edition.source_url,
        confidence=edition.confidence,
        status=edition.status,
    )


def _highest_owned(summary: SeriesSummary) -> int:
    nums = [o.volume for o in summary.owned_volumes if o.volume is not None]
    return int(max(nums)) if nums else 0


async def research_series_releases(
    user_id: int,
    series_key: str,
    *,
    settings: Settings | None = None,
    conn: aiosqlite.Connection | None = None,
    research_fn: Any | None = None,
    user_data: UserData | None = None,
) -> SeriesSummary | None:
    """Research the next PL/EN volume for one series on the web and store the result.

    Stores the per-language next-expected into ``series_info`` (``next_expected_pl`` /
    ``next_expected_en``), sets the combined ``next_expected`` to whichever edition has a
    concrete date (preferring the original/English), upserts one ``expected_books`` entry
    per language (keeping any manual entries), and bumps ``total_known`` when a newer
    volume number is implied. Clears the ``checking`` flag at the end. Never calls Google
    Books.

    ``conn`` may be passed to reuse the caller's connection; otherwise a fresh one is
    opened and closed. ``research_fn`` is injected by tests (a fake returning a
    ResearchResult) to avoid AWS/network.
    """
    settings = settings or get_settings()
    own_conn = conn is None
    if own_conn:
        data = user_data or get_current_user_data()
        conn = await connect(data.database_file)
    assert conn is not None
    try:
        summary = await get_series(conn, user_id, series_key)
        if summary is None:
            return None
        key = summary.series_key
        owned = [o.volume for o in summary.owned_volumes if o.volume is not None]

        if research_fn is None:
            from app.agent.series_research import research_next_volumes

            research_fn = research_next_volumes
        try:
            result = await research_fn(summary.name, summary.author, owned)
        except Exception:  # noqa: BLE001 - research is best-effort
            logger.warning("release research raised for %s", summary.name, exc_info=True)
            result = None

        info = await repo.get_info(conn, user_id, key) or SeriesInfo(
            series_key=key, display_name=summary.name, author=summary.author
        )
        info.display_name = summary.name
        info.author = summary.author or info.author

        pl = _next_expected_from_edition(result.pl) if result else None
        en = _next_expected_from_edition(result.en) if result else None
        info.next_expected_pl = pl
        info.next_expected_en = en
        # Combined next_expected (legacy card field): prefer the edition with a concrete
        # date, original/English first.
        info.next_expected = (
            en if (en and en.date) else pl if (pl and pl.date) else en or pl or info.next_expected
        )
        # Mark the series not complete if a newer volume is known to exist.
        highest = _highest_owned(summary)
        if (pl and pl.status != "unknown") or (en and en.status != "unknown"):
            info.total_known = max(info.total_known or 0, highest + 1)
        info.checking = False
        await repo.upsert_info(conn, user_id, info, touch_checked=True)

        # Upsert one waiting-list entry per language (keep manual entries untouched).
        await _sync_waiting_entry(conn, user_id, key, summary.name, summary.author, "pl", pl)
        await _sync_waiting_entry(conn, user_id, key, summary.name, summary.author, "en", en)

        return await get_series(conn, user_id, key)
    finally:
        if own_conn:
            await conn.close()


async def _sync_waiting_entry(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    series_name: str,
    author: str,
    lang: str,
    nxt: NextExpected | None,
) -> None:
    """Upsert the waiting-list entry for one language's next-expected volume.

    Identified by ``source == f"series_research:{lang}"`` so re-running updates the same
    row and manual entries (source 'agent'/'user') are never touched. A ``None`` / titleless
    result removes a previously-researched entry for that language.
    """
    source = f"series_research:{lang}"
    existing = [
        e
        for e in await repo.find_expected_by_series(conn, user_id, series_key)
        if (e.source or "") == source
    ]
    if nxt is None or not nxt.title:
        for entry in existing:
            await repo.delete_expected(conn, user_id, entry.id)
        return
    label = "PL" if lang == "pl" else "EN"
    payload = {
        "title": nxt.title,
        "author": author,
        "series_name": series_name,
        "expected_date": nxt.date,
        "source_url": nxt.source_url,
        "source": source,
        "confidence": nxt.confidence,
        "notes": f"{label} edition · {nxt.status or 'unknown'}",
    }
    if existing:
        await repo.update_expected(conn, user_id, existing[0].id, payload)
        for extra in existing[1:]:
            await repo.delete_expected(conn, user_id, extra.id)
    else:
        await repo.add_expected(
            conn,
            user_id,
            ExpectedBookCreate(
                title=nxt.title,
                author=author,
                series_name=series_name,
                expected_date=nxt.date,
                source_url=nxt.source_url,
                source=source,
                confidence=nxt.confidence,
                notes=f"{label} edition · {nxt.status or 'unknown'}",
            ),
            series_key=series_key,
        )


async def alerts(conn: aiosqlite.Connection, user_id: int) -> AlertsResponse:
    """Build the Series-tab notifications: in-progress series and new-volume announcements."""
    summaries = await list_series(conn, user_id)
    in_progress: list[SeriesAlert] = []
    new_volume: list[SeriesAlert] = []
    for s in summaries:
        if s.section == "in_progress" and (s.unread_owned_count > 0 or s.missing_volumes):
            bits = []
            if s.unread_owned_count > 0:
                bits.append(f"{s.unread_owned_count} unread owned")
            if s.missing_volumes:
                bits.append(f"{len(s.missing_volumes)} missing")
            in_progress.append(
                SeriesAlert(
                    kind="in_progress",
                    series_key=s.series_key,
                    series_name=s.name,
                    message=f"{s.name}: {s.read_count} of {s.total_known or s.owned_count} read",
                    detail=", ".join(bits) or None,
                )
            )
        if s.watch and s.next_expected and s.next_expected.title:
            new_volume.append(
                SeriesAlert(
                    kind="new_volume",
                    series_key=s.series_key,
                    series_name=s.name,
                    message=f"New volume for {s.name}: {s.next_expected.title}",
                    detail=s.next_expected.date,
                    source_url=s.next_expected.source_url,
                )
            )
    return AlertsResponse(
        count=len(in_progress) + len(new_volume),
        in_progress=in_progress,
        new_volume=new_volume,
    )


# --- series editing (wave 5) -------------------------------------------------------------
#
# These change the series' cached metadata and its membership. Every change to a member
# book's series/volume is written to the DB AND mirrored into data/books.json (via
# app.services.books_json) so the two stores never drift. Reading data and the
# comparisons table are never touched — only the book's `series` and `volume` fields.


def _identity(book: Book) -> dict[str, Any]:
    """The fields books_json uses to find a book's JSON record."""
    return {
        "google_volume_id": book.google_volume_id,
        "isbn_13": book.isbn_13,
        "isbn_10": book.isbn_10,
        "external_id": book.external_id,
        "title": book.title,
        "authors": list(book.authors or []),
    }


async def _set_book_series(
    conn: aiosqlite.Connection,
    user_id: int,
    book_id: int,
    *,
    series: str | None,
    volume: str | None,
) -> Book | None:
    """Update one book's series/volume in the DB and mirror it into books.json."""
    updated = await books_repo.update_book(
        conn, user_id, book_id, BookUpdate(series=series, volume=volume)
    )
    if updated is not None:
        books_json.sync_book_series(_identity(updated), series=series, volume=volume)
    return updated


async def update_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    *,
    display_name: str | None = None,
    aliases: list[str] | None = None,
    author: str | None = None,
    total_volumes: int | None = None,
    notes: str | None = None,
    watch: bool | None = None,
) -> SeriesSummary | None:
    """Edit a series' cached metadata (name shown on the card, aliases, author, total,
    notes, watch flag). Only the arguments that are not ``None`` are applied.

    This edits the ``series_info`` row only; it does NOT rename the series on the member
    books (use :func:`rename_series` for that). ``display_name`` here changes the name the
    Series card shows for the canonical key.
    """
    summary = await get_series(conn, user_id, series_key)
    target_key = summary.series_key if summary else compute.series_key(series_key)
    existing = await repo.get_info(conn, user_id, target_key)
    info = existing or SeriesInfo(
        series_key=target_key,
        display_name=summary.name if summary else series_key,
        author=summary.author if summary else "",
    )
    if display_name is not None and display_name.strip():
        info.display_name = display_name.strip()
    if aliases is not None:
        info.aliases = sorted({a.strip() for a in aliases if a.strip()})
    if author is not None:
        info.author = author.strip()
    if total_volumes is not None:
        info.total_known = total_volumes
    if notes is not None:
        info.notes = notes.strip() or None
    if watch is not None:
        info.watch = watch
        # Turning watch ON schedules a background research run (the route adds the task);
        # flag it so the card shows the "Checking new volumes…" spinner while it runs.
        if watch:
            info.checking = True
    await repo.upsert_info(conn, user_id, info)
    return await get_series(conn, user_id, info.series_key)


async def add_book_to_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    book_id: int,
    *,
    volume: str | None = None,
) -> SeriesSummary | None:
    """Add a library book to a series: set its ``series`` to the series' display name and
    its ``volume``. Works for an existing series (resolved by key/alias) and for a brand
    new series name passed as ``series_key``.
    """
    summary = await get_series(conn, user_id, series_key)
    if summary is not None:
        name = summary.name
        key = summary.series_key
    else:
        # A new series: the caller passed its name. Keep that as the display name.
        name = series_key
        key = compute.series_key(series_key)
    book = await books_repo.get_book(conn, user_id, book_id)
    if book is None:
        return None
    await _set_book_series(conn, user_id, book_id, series=name, volume=volume)
    # Ensure a cached row exists so the series is addressable even before a lookup.
    if await repo.get_info(conn, user_id, key) is None:
        await repo.upsert_info(
            conn,
            user_id,
            SeriesInfo(
                series_key=key, display_name=name, author=book.authors[0] if book.authors else ""
            ),
        )
    return await get_series(conn, user_id, key)


async def remove_book_from_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    book_id: int,
) -> SeriesSummary | None:
    """Remove a book from a series: clear its ``series`` and ``volume``."""
    summary = await get_series(conn, user_id, series_key)
    key = summary.series_key if summary else compute.series_key(series_key)
    book = await books_repo.get_book(conn, user_id, book_id)
    if book is None:
        return None
    await _set_book_series(conn, user_id, book_id, series=None, volume=None)
    return await get_series(conn, user_id, key)


async def set_book_volume(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    book_id: int,
    *,
    volume: str | None,
) -> SeriesSummary | None:
    """Change a member book's volume number within its series (series unchanged)."""
    summary = await get_series(conn, user_id, series_key)
    key = summary.series_key if summary else compute.series_key(series_key)
    book = await books_repo.get_book(conn, user_id, book_id)
    if book is None:
        return None
    await _set_book_series(conn, user_id, book_id, series=book.series, volume=volume)
    return await get_series(conn, user_id, key)


async def rename_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    new_name: str,
) -> SeriesSummary | None:
    """Rename a series on EVERY member book and keep the old name as an alias.

    The old display name becomes an alias on the (new) cached row so the series is still
    found by its previous name. Every member book's ``series`` is rewritten (DB + JSON).
    """
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    new_name = new_name.strip()
    if not new_name:
        return summary
    old_name = summary.name
    new_key = compute.series_key(new_name)

    for owned in summary.owned_volumes:
        book = await books_repo.get_book(conn, user_id, owned.book_id)
        if book is None:
            continue
        await _set_book_series(conn, user_id, owned.book_id, series=new_name, volume=book.volume)

    old_info = await repo.get_info(conn, user_id, summary.series_key)
    merged_aliases = set(old_info.aliases if old_info else [])
    if old_name and compute.series_key(old_name) != new_key:
        merged_aliases.add(old_name)
    merged_aliases.discard(new_name)

    new_info = await repo.get_info(conn, user_id, new_key) or SeriesInfo(series_key=new_key)
    new_info.display_name = new_name
    new_info.aliases = sorted({a for a in merged_aliases if a.strip()})
    if old_info:
        new_info.author = new_info.author or old_info.author
        new_info.known_volumes = new_info.known_volumes or old_info.known_volumes
        new_info.total_known = new_info.total_known or old_info.total_known
        new_info.watch = new_info.watch or old_info.watch
    await repo.upsert_info(conn, user_id, new_info)
    return await get_series(conn, user_id, new_key)


async def merge_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    other_key: str,
) -> SeriesSummary | None:
    """Merge ``other_key`` INTO ``series_key``: every book of the other series is moved to
    this series' display name, and the other series' name + aliases are kept as aliases.
    """
    target = await get_series(conn, user_id, series_key)
    other = await get_series(conn, user_id, other_key)
    if target is None or other is None:
        return None
    if target.series_key == other.series_key:
        return target

    for owned in other.owned_volumes:
        book = await books_repo.get_book(conn, user_id, owned.book_id)
        if book is None:
            continue
        await _set_book_series(conn, user_id, owned.book_id, series=target.name, volume=book.volume)

    target_info = await repo.get_info(conn, user_id, target.series_key) or SeriesInfo(
        series_key=target.series_key, display_name=target.name, author=target.author
    )
    merged = set(target_info.aliases)
    merged.update(other.aliases)
    if other.name and compute.series_key(other.name) != target.series_key:
        merged.add(other.name)
    merged.discard(target.name)
    target_info.aliases = sorted({a for a in merged if a.strip()})
    await repo.upsert_info(conn, user_id, target_info)
    return await get_series(conn, user_id, target.series_key)


# --- waiting list ------------------------------------------------------------------------


async def list_expected(conn: aiosqlite.Connection, user_id: int) -> list[ExpectedBook]:
    return await repo.list_expected(conn, user_id)


async def add_expected(
    conn: aiosqlite.Connection, user_id: int, data: ExpectedBookCreate
) -> ExpectedBook:
    key = compute.series_key(data.series_name) if data.series_name else None
    return await repo.add_expected(conn, user_id, data, series_key=key or None)


async def remove_expected(conn: aiosqlite.Connection, user_id: int, expected_id: int) -> bool:
    return await repo.delete_expected(conn, user_id, expected_id)


# --- aliases & book-fix dry-run ----------------------------------------------------------


async def set_aliases(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    aliases: list[str],
) -> SeriesInfo | None:
    summary = await get_series(conn, user_id, series_key)
    target_key = summary.series_key if summary else compute.series_key(series_key)
    existing = await repo.get_info(conn, user_id, target_key)
    info = existing or SeriesInfo(
        series_key=target_key,
        display_name=summary.name if summary else series_key,
        author=summary.author if summary else "",
    )
    info.aliases = sorted({a.strip() for a in aliases if a.strip()})
    return await repo.upsert_info(conn, user_id, info)


async def suggest_series_fixes(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    *,
    settings: Settings | None = None,
) -> list[dict[str, Any]]:
    """Dry-run: for books by the series' author with no series set (or wrong volume),
    match their title against the series' known volumes and propose a fix.

    Returns a list of ``{book_id, title, current_series, current_volume, new_series,
    new_volume, matched_known_title}`` — the caller reports this; the live data is
    never modified here.
    """
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return []
    info = await repo.get_info(conn, user_id, summary.series_key)
    known = info.known_volumes if info else []
    if not known:
        await _lookup_and_cache(conn, user_id, summary, settings=settings)
        info = await repo.get_info(conn, user_id, summary.series_key)
        known = info.known_volumes if info else []

    known_by_title = {compute.series_key(k.title): k for k in known if k.title}
    author_fold = compute.series_key(summary.author)
    books = await books_repo.list_books(conn, user_id)
    suggestions: list[dict[str, Any]] = []
    for book in books:
        if not book.authors:
            continue
        if not any(compute.series_key(a) == author_fold for a in book.authors):
            continue
        current_key = compute.series_key(book.series) if book.series else ""
        # Already correctly in this series with a volume -> skip.
        if current_key == summary.series_key and book.volume:
            continue
        match = known_by_title.get(compute.series_key(book.title))
        if match is None:
            continue
        new_volume = str(int(match.number)) if match.number is not None else None
        if current_key == summary.series_key and book.volume == new_volume:
            continue
        suggestions.append(
            {
                "book_id": book.id,
                "title": book.title,
                "current_series": book.series,
                "current_volume": book.volume,
                "new_series": summary.name,
                "new_volume": new_volume,
                "matched_known_title": match.title,
            }
        )
    return suggestions
