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
from app.repositories import prefs as prefs_repo
from app.repositories import series as repo
from app.schemas.books import Book, BookCreate, BookUpdate, ReadingStatus
from app.schemas.series import (
    AlertsResponse,
    ExpectedBook,
    ExpectedBookCreate,
    NextExpected,
    SeriesAlert,
    SeriesCheckResult,
    SeriesInfo,
    SeriesPreferences,
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
    existing = await repo.get_info(conn, user_id, summary.series_key)
    info = existing or SeriesInfo(
        series_key=summary.series_key,
        display_name=summary.name,
        author=summary.author,
    )
    info.watch = watch
    # Turning watch ON schedules a web release-research run; flag it so the UI can show a
    # "Checking new volumes…" spinner while the background task runs. The caller (the route)
    # kicks off research_series_releases() after this returns. A newly-watched series with
    # no explicit language takes the user's default search language.
    info.checking = watch
    if watch and (existing is None or not existing.search_lang):
        prefs = await get_series_preferences(conn, user_id)
        info.search_lang = prefs.default_search_lang
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
    search_lang: str | None = None,
    settings: Settings | None = None,
) -> SeriesSummary | None:
    """Run the web release-research step for one series now and store the result.

    This is the same step the watch toggle and ``POST /api/series/check`` use. An optional
    ``search_lang`` is a one-off override that is also saved to the series. The research
    may call Google Books ONCE for an auto-add — see :mod:`app.agent.series_research`.
    """
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    await research_series_releases(
        user_id, summary.series_key, search_lang=search_lang, settings=settings, conn=conn
    )
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
        notes="Source: web release research. Google Books used only to auto-add a released volume.",
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
    search_lang: str | None = None,
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
    if conn is None:  # unreachable; narrows the type without a bandit-flagged assert
        raise RuntimeError("no database connection")
    try:
        summary = await get_series(conn, user_id, series_key)
        if summary is None:
            return None
        key = summary.series_key
        owned = [o.volume for o in summary.owned_volumes if o.volume is not None]

        existing_info = await repo.get_info(conn, user_id, key)
        effective_lang: str = (
            search_lang
            if search_lang is not None and search_lang in ("pl", "en", "both")
            else (existing_info.search_lang if existing_info else "pl")
        )
        if effective_lang not in ("pl", "en", "both"):
            effective_lang = "pl"

        if research_fn is None:
            from app.agent.series_research import research_next_volumes

            aliases = list(summary.aliases or [])

            async def _research(name: str, author: str, owned_: list[float]) -> Any:
                # Pass the other-language names (e.g. "Kroniki Mroku" for "King's Dark
                # Tidings") so the Polish edition is searched under its Polish title, and the
                # per-series search language so only the requested edition is researched.
                return await research_next_volumes(
                    name, author, owned_, search_lang=effective_lang, aliases=aliases
                )

            research_fn = _research

        try:
            result = await research_fn(summary.name, summary.author, owned)
        except Exception:  # noqa: BLE001 - research is best-effort
            logger.warning("release research raised for %s", summary.name, exc_info=True)
            result = None

        info = existing_info or SeriesInfo(
            series_key=key, display_name=summary.name, author=summary.author
        )
        info.display_name = summary.name
        info.author = summary.author or info.author
        info.search_lang = effective_lang

        release_summary = result.summary if result else None
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

        # Auto-add: when the researched edition is released/announced and we have a real
        # next title that the user does not already own, try ONE Google Books lookup and
        # add the book to the library (status 'want'). Mutates release_summary.added_book_id
        # and removes the matching waiting-list entry. Never adds twice.
        if release_summary is not None:
            await _maybe_auto_add(conn, user_id, summary, release_summary, settings=settings)
        info.release_summary = release_summary
        info.checking = False
        await repo.upsert_info(conn, user_id, info, touch_checked=True)

        # Waiting list: one clean entry only when a real next_title exists, and delete any
        # old garbage researched entries that never had a real title.
        await _sync_waiting_list(conn, user_id, key, summary.name, summary.author, release_summary)

        return await get_series(conn, user_id, key)
    finally:
        if own_conn:
            await conn.close()


def _owns_volume(summary: SeriesSummary, volume: float | None) -> bool:
    """True when the library already holds this series volume number."""
    if volume is None:
        return False
    return any(
        o.volume is not None and float(o.volume) == float(volume) for o in summary.owned_volumes
    )


async def _researched_waiting_entries(
    conn: aiosqlite.Connection, user_id: int, series_key: str
) -> list[ExpectedBook]:
    """Waiting-list entries this research step owns (source prefix ``series_research``)."""
    return [
        e
        for e in await repo.find_expected_by_series(conn, user_id, series_key)
        if (e.source or "").startswith("series_research")
    ]


async def _sync_waiting_list(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    series_name: str,
    author: str,
    summary: Any | None,
) -> None:
    """Keep exactly one clean waiting-list entry for a series, only with a real title.

    Deletes all previously-researched entries (source prefix ``series_research``) for this
    series — including the old wave-5 ``series_research:pl``/``:en`` garbage that had no
    real title — then, when the editor summary carries a real ``next_title`` AND the book
    was not auto-added (``added_book_id`` unset), creates one clean entry. Manual entries
    (source 'agent'/'user') are never touched.
    """
    for entry in await _researched_waiting_entries(conn, user_id, series_key):
        await repo.delete_expected(conn, user_id, entry.id)

    if summary is None or not summary.next_title:
        return
    # Auto-added already -> it lives in the library, not the waiting list.
    if summary.added_book_id is not None:
        return

    volume = None
    if summary.next_volume is not None:
        volume = (
            str(int(summary.next_volume))
            if float(summary.next_volume).is_integer()
            else str(summary.next_volume)
        )
    source_url = None
    if summary.details:
        source_url = next((d.source_url for d in summary.details if d.source_url), None)
    await repo.add_expected(
        conn,
        user_id,
        ExpectedBookCreate(
            title=summary.next_title,
            author=author,
            series_name=series_name,
            volume=volume,
            expected_date=summary.expected_date,
            source_url=source_url,
            source="series_research",
            notes=summary.headline or None,
        ),
        series_key=series_key,
    )


def _title_words_match(wanted: str, found: str) -> bool:
    """All significant words of ``wanted`` appear in ``found`` (order-free)."""
    from app.services.series import series_key as _key

    stop = {"the", "a", "an", "of", "and", "to", "in"}
    want_words = {w for w in _key(wanted).split() if w and w not in stop}
    found_words = set(_key(found).split())
    if not want_words:
        return False
    return want_words.issubset(found_words)


def _surname_close(author: str, candidate_authors: list[str]) -> bool:
    """True when the author's surname closely matches one of the candidate authors.

    Accepts a small edit distance on the surname (handles e.g. Machanienko / Mahanenko).
    An empty expected author accepts any candidate.
    """
    from app.services.series import series_key as _key

    if not author:
        return True

    def _surname(name: str) -> str:
        parts = _key(name).split()
        return parts[-1] if parts else ""

    def _close(a: str, b: str) -> bool:
        if not a or not b:
            return False
        if a == b or a in b or b in a:
            return True
        # Levenshtein distance <= 2 for short surnames.
        la, lb = len(a), len(b)
        if abs(la - lb) > 2:
            return False
        prev = list(range(lb + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[lb] <= 2

    want = _surname(author)
    return any(_close(want, _surname(c)) for c in candidate_authors)


MAX_AUTO_ADDS_PER_RUN = 3


async def _maybe_auto_add(
    conn: aiosqlite.Connection,
    user_id: int,
    summary: SeriesSummary,
    release: Any,
    *,
    settings: Settings | None = None,
) -> None:
    """Handle every volume the research found that the user does not own.

    Owned numbers are dropped from ``release.found_volumes``. Then, per the user's
    ``add_mode`` preference: 'auto' adds each released/announced one to the library as
    'want' (at most ``MAX_AUTO_ADDS_PER_RUN`` per run, one Google Books query each);
    'ask' leaves them on the card with an Add button. Never adds twice.
    """
    if release is None:
        return
    from app.schemas.series import FoundVolume

    # The named next volume is always a candidate, even if the editor left it out of the list.
    if release.next_title and not any(
        (fv.volume is not None and fv.volume == release.next_volume)
        or fv.title == release.next_title
        for fv in release.found_volumes
    ):
        release.found_volumes.append(
            FoundVolume(
                volume=release.next_volume,
                title=release.next_title,
                status=release.status if release.status in ("released", "announced") else "unknown",
                date=release.expected_date,
                added_book_id=release.added_book_id,
            )
        )
    release.found_volumes = [
        fv
        for fv in release.found_volumes
        if fv.added_book_id is not None or not _owns_volume(summary, fv.volume)
    ]
    prefs = await get_series_preferences(conn, user_id)
    if prefs.add_mode != "auto":
        return
    added = 0
    for fv in release.found_volumes:
        if added >= MAX_AUTO_ADDS_PER_RUN:
            break
        if fv.added_book_id is not None or fv.status not in ("released", "announced"):
            continue
        book_id = await _add_volume(conn, user_id, summary, fv.title, fv.volume, settings=settings)
        if book_id is None:
            continue
        added += 1
        fv.added_book_id = book_id
        if release.next_volume is not None and fv.volume == release.next_volume:
            release.added_book_id = book_id
        elif release.next_title and fv.title == release.next_title:
            release.added_book_id = book_id


async def _add_volume(
    conn: aiosqlite.Connection,
    user_id: int,
    summary: SeriesSummary,
    title: str,
    volume: float | None,
    *,
    settings: Settings | None = None,
) -> int | None:
    """Add one series volume to the library as 'want'. Returns the new book id.

    ONE Google Books search (title + author) through the shared client (disk cache +
    ``GOOGLE_BOOKS_MAX_CALLS`` budget; a 429/budget stops it with no retries). The hit is
    used only when its significant title words match and the author surname is close.
    Without a usable hit the book is still added from the title, author, series and
    volume (no cover), so it appears in the library. Returns ``None`` if it already exists.
    """
    from app.services import books as books_service

    settings = settings or get_settings()
    hit = None
    query = f"{title} {summary.author}".strip()
    try:
        _total, items = await _client(settings).search(query, max_results=5)
        for item in items:
            if _title_words_match(title, item.title) and _surname_close(
                summary.author, list(item.authors or [])
            ):
                hit = item
                break
    except Exception:  # noqa: BLE001 - 429/budget/transport: add from the title instead
        logger.info("Google Books lookup skipped for %r", query, exc_info=True)

    vol_str = None
    if volume is not None:
        vol_str = str(int(volume)) if float(volume).is_integer() else str(volume)
    authors = [summary.author] if summary.author else []
    if hit is not None:
        create = BookCreate(
            google_volume_id=hit.google_volume_id,
            title=hit.title,
            subtitle=hit.subtitle,
            authors=list(hit.authors or []) or authors,
            publisher=hit.publisher,
            published_date=hit.published_date,
            description=hit.description,
            page_count=hit.page_count,
            categories=list(hit.categories or []),
            language=hit.language,
            isbn_10=hit.isbn_10,
            isbn_13=hit.isbn_13,
            cover_url=hit.cover_url,
            series=summary.name,
            volume=vol_str,
            status=ReadingStatus.want,
            metadata_source="series_research",
        )
    else:
        create = BookCreate(
            title=title,
            authors=authors,
            series=summary.name,
            volume=vol_str,
            status=ReadingStatus.want,
            metadata_source="series_research",
        )
    try:
        book = await books_service.add_book(conn, user_id, create)
    except books_service.DuplicateBookError:
        return None
    books_json.sync_book_series(
        {
            "google_volume_id": book.google_volume_id,
            "isbn_13": book.isbn_13,
            "isbn_10": book.isbn_10,
            "external_id": book.external_id,
            "title": book.title,
            "authors": list(book.authors or []),
        },
        series=summary.name,
        volume=vol_str,
    )
    return book.id


async def add_found_volume(
    conn: aiosqlite.Connection,
    user_id: int,
    series_key: str,
    title: str,
    volume: float | None,
    *,
    settings: Settings | None = None,
) -> SeriesSummary | None:
    """Add one found volume from the card's Add button (add_mode 'ask')."""
    summary = await get_series(conn, user_id, series_key)
    if summary is None:
        return None
    book_id = await _add_volume(conn, user_id, summary, title, volume, settings=settings)
    info = await repo.get_info(conn, user_id, summary.series_key)
    if info is not None and info.release_summary is not None and book_id is not None:
        rs = info.release_summary
        for fv in rs.found_volumes:
            if (volume is not None and fv.volume == volume) or fv.title == title:
                fv.added_book_id = book_id
        if (volume is not None and rs.next_volume == volume) or rs.next_title == title:
            rs.added_book_id = book_id
        await repo.upsert_info(conn, user_id, info)
        await _sync_waiting_list(
            conn, user_id, summary.series_key, summary.name, summary.author, rs
        )
    return await get_series(conn, user_id, summary.series_key)


def _alert_key(kind: str, series_key: str, *parts: str | None) -> str:
    """Build a stable alert identity from its kind, series and the fields that matter.

    The key changes when a meaningful field changes, so a NEW alert (a new volume, a
    newly-announced or changed date, a release) gets a different key and shows again even
    after an older alert for the same series was dismissed. ``None`` parts are normalised
    to an empty segment so the key is stable across runs.
    """
    segments = [kind, series_key, *[(p or "").strip() for p in parts]]
    return "|".join(segments)


def _build_alerts(summaries: list[SeriesSummary]) -> tuple[list[SeriesAlert], list[SeriesAlert]]:
    """Build the in-progress and new-volume alert lists (without seen state)."""
    in_progress: list[SeriesAlert] = []
    new_volume: list[SeriesAlert] = []
    for s in summaries:
        if s.section == "in_progress" and (s.unread_owned_count > 0 or s.missing_volumes):
            bits = []
            if s.unread_owned_count > 0:
                bits.append(f"{s.unread_owned_count} unread owned")
            if s.missing_volumes:
                bits.append(f"{len(s.missing_volumes)} missing")
            # The in-progress alert's identity tracks what the user still has to read; it
            # changes (and so reappears) when they acquire a new volume or read one.
            key = _alert_key(
                "in_progress",
                s.series_key,
                str(s.unread_owned_count),
                str(len(s.missing_volumes)),
            )
            in_progress.append(
                SeriesAlert(
                    kind="in_progress",
                    series_key=s.series_key,
                    series_name=s.name,
                    message=f"{s.name}: {s.read_count} of {s.total_known or s.owned_count} read",
                    detail=", ".join(bits) or None,
                    alert_key=key,
                )
            )
        if s.watch and s.next_expected and s.next_expected.title:
            nxt = s.next_expected
            # The new-volume alert's identity tracks the volume title, its date and its
            # status, so a date being announced, a date changing, or a release flipping the
            # status all yield a fresh key the user has not seen yet.
            key = _alert_key(
                "new_volume",
                s.series_key,
                nxt.title,
                nxt.date,
                nxt.status,
            )
            new_volume.append(
                SeriesAlert(
                    kind="new_volume",
                    series_key=s.series_key,
                    series_name=s.name,
                    message=f"New volume for {s.name}: {nxt.title}",
                    detail=nxt.date,
                    source_url=nxt.source_url,
                    alert_key=key,
                )
            )
    return in_progress, new_volume


async def alerts(conn: aiosqlite.Connection, user_id: int) -> AlertsResponse:
    """Build the Series-tab notifications with per-user seen state.

    Each alert carries a stable ``alert_key`` and a ``seen`` flag (whether this user has
    dismissed that exact key). ``count`` / ``unseen_count`` is the number of UNSEEN alerts
    (the badge value). Both lists carry every alert so the UI can reveal seen ones on
    demand. Stale seen rows (keys no longer present) are pruned so the table stays small.
    """
    summaries = await list_series(conn, user_id)
    in_progress, new_volume = _build_alerts(summaries)

    all_keys = {a.alert_key for a in (*in_progress, *new_volume)}
    seen_keys = await repo.seen_alert_keys(conn, user_id)
    await repo.prune_seen_alerts(conn, user_id, all_keys)

    # A dismissed alert is gone for good: it is not returned at all (no "earlier" list).
    # Only its key is remembered, so the same alert does not pop up again; a genuinely
    # new event has a new key and shows.
    in_progress = [a for a in in_progress if a.alert_key not in seen_keys]
    new_volume = [a for a in new_volume if a.alert_key not in seen_keys]
    unseen = len(in_progress) + len(new_volume)

    return AlertsResponse(
        count=unseen,
        unseen_count=unseen,
        in_progress=in_progress,
        new_volume=new_volume,
    )


async def mark_alerts_seen(
    conn: aiosqlite.Connection,
    user_id: int,
    *,
    alert_keys: list[str] | None = None,
    all_unseen: bool = False,
) -> int:
    """Dismiss alerts for this user.

    With ``all_unseen`` set, every currently-unseen alert is dismissed; otherwise the
    given ``alert_keys`` are dismissed. Returns the number of newly-recorded keys.
    """
    if all_unseen:
        current = await alerts(conn, user_id)
        keys = [a.alert_key for a in (*current.in_progress, *current.new_volume) if not a.seen]
    else:
        keys = [k for k in (alert_keys or []) if k]
    if not keys:
        return 0
    return await repo.mark_alerts_seen(conn, user_id, keys)


# --- per-user UI preferences (series-ux) -------------------------------------------------

SERIES_FILTERS = ("all", "watching", "in_progress", "missing", "complete", "owned")
_SERIES_PREF_KEY = "series"


async def get_series_preferences(conn: aiosqlite.Connection, user_id: int) -> SeriesPreferences:
    """Return the user's Series-tab preferences, defaulting when never set."""
    stored = await prefs_repo.get_pref(conn, user_id, _SERIES_PREF_KEY)
    if not stored:
        return SeriesPreferences()
    raw_filter = str(stored.get("filter", "all"))
    active = raw_filter if raw_filter in SERIES_FILTERS else "all"
    sort = stored.get("sort")
    raw_lang = str(stored.get("default_search_lang", "pl"))
    lang = raw_lang if raw_lang in ("pl", "en", "both") else "pl"
    raw_mode = str(stored.get("add_mode", "auto"))
    return SeriesPreferences(
        filter=active,
        sort=sort if isinstance(sort, str) else None,
        default_search_lang=lang,
        add_mode=raw_mode if raw_mode in ("auto", "ask") else "auto",
    )


async def set_series_preferences(
    conn: aiosqlite.Connection, user_id: int, prefs: SeriesPreferences
) -> SeriesPreferences:
    """Persist the user's Series-tab preferences (validated filter id)."""
    active = prefs.filter if prefs.filter in SERIES_FILTERS else "all"
    lang = prefs.default_search_lang if prefs.default_search_lang in ("pl", "en", "both") else "pl"
    value: dict[str, Any] = {
        "filter": active,
        "default_search_lang": lang,
        "add_mode": prefs.add_mode if prefs.add_mode in ("auto", "ask") else "auto",
    }
    if prefs.sort:
        value["sort"] = prefs.sort
    await prefs_repo.set_pref(conn, user_id, _SERIES_PREF_KEY, value)
    return SeriesPreferences(
        filter=active, sort=prefs.sort, default_search_lang=lang, add_mode=value["add_mode"]
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
    search_lang: str | None = None,
) -> SeriesSummary | None:
    """Edit a series' cached metadata (name shown on the card, aliases, author, total,
    notes, watch flag, search language). Only the arguments that are not ``None`` are
    applied.

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
    if search_lang is not None and search_lang in ("pl", "en", "both"):
        info.search_lang = search_lang
    if watch is not None:
        info.watch = watch
        # Turning watch ON schedules a background research run (the route adds the task);
        # flag it so the card shows the "Checking new volumes…" spinner while it runs. A
        # newly-watched series with no explicit language takes the user's default.
        if watch:
            info.checking = True
            if search_lang is None and (existing is None or not existing.search_lang):
                prefs = await get_series_preferences(conn, user_id)
                info.search_lang = prefs.default_search_lang
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


# --- automatic check on app open ---------------------------------------------------------
#
# There is no scheduler on Fly.io (the machine sleeps when idle, so a timer would have to
# wake it). Instead, when a person opens the app (``GET /api/auth/me``) and their watched
# series were last checked more than ``AUTO_CHECK_MAX_AGE_HOURS`` ago, the same
# ``check_watched_series`` run starts in the background. The machine is awake at that
# moment anyway, so this costs no extra wake-ups.

AUTO_CHECK_MAX_AGE_HOURS = 24
_auto_check_running: set[str] = set()


def _parse_ts(value: str | None) -> Any:
    from datetime import datetime, timezone

    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def watched_series_stale(
    db_file: Path, *, max_age_hours: float = AUTO_CHECK_MAX_AGE_HOURS
) -> bool:
    """True when at least one watched series was never checked or is older than the limit."""
    from datetime import datetime, timedelta, timezone

    if not db_file.is_file():
        return False
    conn = await connect(db_file)
    try:
        watched = await repo.list_watched(conn, user_id=SINGLE_USER_ID)
    finally:
        await conn.close()
    if not watched:
        return False
    limit = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    for info in watched:
        if info.checking:
            continue
        checked = _parse_ts(info.last_checked)
        if checked is None or checked < limit:
            return True
    return False


async def auto_check_if_stale(
    user_data: UserData,
    *,
    settings: Settings | None = None,
    max_age_hours: float = AUTO_CHECK_MAX_AGE_HOURS,
) -> bool:
    """Run the watched-series check for one person if it is stale. Returns True if it ran.

    One run per data folder at a time, so opening the app on two devices does not start two.
    Never raises: a failed check only logs.
    """
    key = str(user_data.database_file)
    if key in _auto_check_running:
        return False
    try:
        if not await watched_series_stale(user_data.database_file, max_age_hours=max_age_hours):
            return False
        _auto_check_running.add(key)
        result = await check_watched_series(
            db_file=user_data.database_file, settings=settings, user_id=SINGLE_USER_ID
        )
        logger.info("auto series check: checked %s, updated %s", result.checked, result.updated)
        return True
    except Exception:  # noqa: BLE001 - best effort, never break app open
        logger.warning("auto series check failed", exc_info=True)
        return False
    finally:
        _auto_check_running.discard(key)
