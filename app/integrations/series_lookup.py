"""Series lookup: find the known volumes and the next release of a series (wave 5).

Searches external catalogues for every volume of a series so the Series tab can show
total/missing volumes and a watched series' next expected release:

- **Google Books**: ``intitle:"<series>" inauthor:"<author>"`` with ``langRestrict`` —
  Polish editions first, then English (the user reads both; e.g. all the English
  "King's Dark Tidings" volumes). Published dates give the newest/next release.
- **OpenLibrary**: a keyless second source (no quota), same query.

The library's Bedrock agent does its own web research through the agent tools; this
module stays HTTP-only (Google Books + OpenLibrary) and the series-tracking doc records
that the periodic checker uses exactly these two sources plus the agent's reasoning.

Volume numbers are parsed from each hit's title via :func:`app.services.series.parse_volume`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

import httpx

from app.integrations.google_books import GoogleBooksClient
from app.integrations.openlibrary import OpenLibraryClient
from app.schemas.books import VolumeSearchResult
from app.schemas.series import KnownVolume, NextExpected
from app.services import series as series_logic

logger = logging.getLogger(__name__)

# Languages searched, in priority order (Polish editions first, then English).
_LANGS = ("pl", "en")


@dataclass
class LookupStatus:
    """What the external lookup managed to do, for the cached ``last_checked``/notes.

    ``google_ok`` is False when Google Books refused (e.g. 429 'Queries per day'); the
    lookup then relies on OpenLibrary and the series is flagged as needing a Google
    re-check later. ``error`` carries a short human note.
    """

    google_ok: bool = True
    openlibrary_ok: bool = True
    quota_exhausted: bool = False
    sources: list[str] = field(default_factory=list)
    error: str | None = None

    def note(self) -> str:
        if self.quota_exhausted:
            return "Google Books quota exhausted (429); used OpenLibrary + library data. Needs a Google re-check."
        if not self.google_ok and self.openlibrary_ok:
            return "Google Books unavailable; used OpenLibrary. Needs a Google re-check."
        if self.error:
            return self.error
        return "Sources: " + ", ".join(self.sources or ["none"]) + "."


def _query(series_name: str, author: str | None) -> str:
    parts = [f'intitle:"{series_name}"']
    if author:
        parts.append(f'inauthor:"{author}"')
    return " ".join(parts)


def _hit_volume(hit: VolumeSearchResult, series_name: str) -> float | None:
    """Best-effort volume number from a hit's title/subtitle."""
    for text in (hit.subtitle, hit.title):
        number = series_logic.parse_volume(None, title=text)
        if number is not None:
            return number
    return None


def _is_quota(exc: Exception) -> bool:
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429


async def _search_all(
    series_name: str,
    author: str | None,
    google: GoogleBooksClient,
    status: LookupStatus,
) -> list[VolumeSearchResult]:
    """Search Google Books (pl then en) then OpenLibrary, de-duplicated by title.

    Handles a Google 429 ('Queries per day') gracefully: the first 429 stops all further
    Google calls this run (no hammering), sets ``quota_exhausted`` and falls back to
    OpenLibrary, which is keyless and not quota-gated. Runs the series-title query first;
    if it yields few numbered volumes, broadens to an author-scoped query so
    distinct-titled volumes (no "Book #N" marker) still surface with their dates.
    """
    hits: list[VolumeSearchResult] = []
    seen: set[str] = set()

    def collect(results: list[VolumeSearchResult]) -> None:
        for hit in results:
            fp = (hit.title or "").strip().casefold()
            if fp and fp not in seen:
                seen.add(fp)
                hits.append(hit)

    async def google_run(q: str) -> None:
        if not status.google_ok:
            return  # already refused this run; do not hammer the quota
        for lang in _LANGS:
            if not status.google_ok:
                return
            try:
                _total, results = await google.search(q, max_results=40, lang=lang)
                collect(results)
                if "google_books" not in status.sources:
                    status.sources.append("google_books")
            except Exception as exc:  # noqa: BLE001
                status.google_ok = False
                if _is_quota(exc):
                    status.quota_exhausted = True
                    logger.warning("Google Books quota exhausted; falling back to OpenLibrary")
                else:
                    status.error = f"Google Books error: {type(exc).__name__}"
                    logger.warning("Google Books series search failed for %r: %s", q, exc)
                return

    async def ol_run(q: str) -> None:
        for lang in _LANGS:
            try:
                _total, results = await OpenLibraryClient(None).search(q, max_results=40, lang=lang)
                collect(results)
                if "openlibrary" not in status.sources:
                    status.sources.append("openlibrary")
            except Exception as exc:  # noqa: BLE001
                status.openlibrary_ok = False
                logger.warning("OpenLibrary series search failed for %r: %s", q, exc)

    query = _query(series_name, author)
    await google_run(query)
    await ol_run(query)

    numbered = sum(1 for h in hits if _hit_volume(h, series_name) is not None)
    if author and numbered < 2:
        author_q = f'inauthor:"{author}"'
        await google_run(author_q)
        await ol_run(author_q)

    return hits


def _dedup_volumes(hits: list[VolumeSearchResult], series_name: str) -> list[KnownVolume]:
    """Collapse hits into one KnownVolume per volume number (earliest published date wins)."""
    by_number: dict[float, KnownVolume] = {}
    for hit in hits:
        number = _hit_volume(hit, series_name)
        if number is None:
            continue
        is_ol = (hit.google_volume_id or "").find("/works/") >= 0
        candidate = KnownVolume(
            number=number,
            title=hit.title,
            published_date=hit.published_date,
            source="openlibrary" if is_ol else "google_books",
        )
        existing = by_number.get(number)
        if existing is None:
            by_number[number] = candidate
            continue
        # Prefer the entry that actually has a published date, then the earliest.
        if existing.published_date is None and candidate.published_date:
            by_number[number] = candidate
        elif (
            existing.published_date
            and candidate.published_date
            and candidate.published_date < existing.published_date
        ):
            by_number[number] = candidate
    return [by_number[n] for n in sorted(by_number)]


async def lookup_series(
    series_name: str,
    author: str | None,
    google: GoogleBooksClient,
) -> tuple[list[KnownVolume], int | None, LookupStatus]:
    """Return ``(known_volumes, total_known, status)`` from the external sources.

    ``status`` says which sources answered and whether Google's quota was exhausted, so
    the caller can record it on the cache and schedule a Google re-check.
    """
    status = LookupStatus()
    hits = await _search_all(series_name, author, google, status)
    known = _dedup_volumes(hits, series_name)
    total = max((int(k.number) for k in known if k.number is not None), default=None)
    return known, total, status


async def find_next_release(
    series_name: str,
    author: str | None,
    owned_numbers: set[float],
    google: GoogleBooksClient,
) -> NextExpected | None:
    """Find the next expected volume (future-dated, or the newest beyond what is owned).

    Used by the watched-series checker. Prefers a volume whose published date is in the
    future; otherwise the highest-numbered known volume the user does not already own.
    """
    known, _total, _status = await lookup_series(series_name, author, google)
    if not known:
        return None

    today = date.today().isoformat()
    future = [k for k in known if k.published_date and k.published_date[:10] >= today[:7]]
    if future:
        future.sort(key=lambda k: k.published_date or "")
        head = future[0]
        return NextExpected(
            title=head.title, date=head.published_date, source_url=None, confidence="high"
        )

    not_owned = [k for k in known if k.number is not None and k.number not in owned_numbers]
    if not_owned:
        not_owned.sort(key=lambda k: k.number or 0.0, reverse=True)
        head = not_owned[0]
        return NextExpected(
            title=head.title, date=head.published_date, source_url=None, confidence="medium"
        )

    # Everything known is owned: report the newest volume as the latest-known release.
    newest = max(known, key=lambda k: (k.published_date or "", k.number or 0.0))
    return NextExpected(
        title=newest.title, date=newest.published_date, source_url=None, confidence="low"
    )
