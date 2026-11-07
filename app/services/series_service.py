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
from app.schemas.series import (
    AlertsResponse,
    ExpectedBook,
    ExpectedBookCreate,
    SeriesAlert,
    SeriesCheckResult,
    SeriesInfo,
    SeriesSummary,
)
from app.services import series as compute

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
    await repo.set_watch(
        conn,
        user_id,
        summary.series_key,
        watch=watch,
        display_name=summary.name,
        author=summary.author,
    )
    return await get_series(conn, user_id, summary.series_key)


async def refresh_series(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    *,
    settings: Settings | None = None,
) -> SeriesSummary | None:
    """Run the external lookup for one series now and cache the result."""
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    await _lookup_and_cache(conn, user_id, summary, settings=settings)
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
) -> SeriesCheckResult:
    """Re-check only the watched series for new volumes / release dates.

    Opens its own connection so it can run detached (manual endpoint, ``just
    check-series`` or a Kiro Crew cron). For each watched series it runs the external
    lookup, refreshes the cached known volumes and the next-expected release, and
    syncs the waiting list (upcoming volume -> an ``expected_books`` entry).

    Release data comes from Google Books (future / newest published dates, PL + EN)
    and OpenLibrary. The library's Bedrock agent performs deeper web research through
    its own tools; this function stays HTTP-only by design (documented in
    docs/features/series-tracking.md).
    """
    settings = settings or get_settings()
    db_file = db_file or settings.database_file
    conn = await connect(db_file)
    updated_names: list[str] = []
    checked = 0
    try:
        watched = await repo.list_watched(conn, user_id=SINGLE_USER_ID)
        summaries = {s.series_key: s for s in await list_series(conn, SINGLE_USER_ID)}
        for info in watched:
            summary = summaries.get(info.series_key)
            if summary is None:
                continue
            checked += 1
            try:
                await _lookup_and_cache(
                    conn, SINGLE_USER_ID, summary, settings=settings, find_next=True
                )
                await _sync_waiting_list(conn, SINGLE_USER_ID, summary.series_key)
                updated_names.append(summary.name)
            except Exception:  # noqa: BLE001 - one series failing must not abort the run
                logger.exception("series check failed for %s", summary.name)
    finally:
        await conn.close()
    return SeriesCheckResult(
        checked=checked,
        updated=len(updated_names),
        series=updated_names,
        notes="Sources: Google Books (PL+EN) and OpenLibrary.",
    )


async def _sync_waiting_list(conn: aiosqlite.Connection, user_id: int, series_key: str) -> None:
    """Mirror a watched series' next-expected volume into the waiting list."""
    summary = await get_series(conn, user_id, series_key)
    if summary is None or summary.next_expected is None:
        return
    nxt = summary.next_expected
    if not nxt.title:
        return
    existing = await repo.find_expected_by_series(conn, user_id, series_key)
    for entry in existing:
        if (entry.title or "").casefold() == (nxt.title or "").casefold():
            await repo.update_expected(
                conn,
                user_id,
                entry.id,
                {
                    "expected_date": nxt.date,
                    "source_url": nxt.source_url,
                    "confidence": nxt.confidence,
                    "source": "series_check",
                },
            )
            return
    await repo.add_expected(
        conn,
        user_id,
        ExpectedBookCreate(
            title=nxt.title,
            author=summary.author,
            series_name=summary.name,
            expected_date=nxt.date,
            source_url=nxt.source_url,
            source="series_check",
            confidence=nxt.confidence,
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
