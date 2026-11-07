"""Series tracking logic (wave 5).

Pure, deterministic computation: given the user's books and the cached ``series_info``
rows, group books into series and compute owned / read / unread-owned / missing volumes.
No HTTP and no SQL here — the service layer feeds it books and lookup rows and persists
the results. This keeps the computation unit-testable in isolation.

Name normalisation
------------------
A *series key* is a casefolded, accent-folded, punctuation-stripped form of the series
name, so "The Way of the Shaman", "the way of the shaman" and "Way of the Shaman" (the
leading article dropped) collapse to one key. Aliases (stored on ``series_info``) let a
series be found by any of its names across languages/editions, e.g.
"King's Dark Tidings" == "Kroniki Mroku".
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING

from app.schemas.series import (
    KnownVolume,
    MissingVolume,
    NextExpected,
    OwnedVolume,
    SeriesInfo,
    SeriesSummary,
)

if TYPE_CHECKING:
    from app.schemas.books import Book

# Leading articles stripped when building a key (one per supported language).
_ARTICLES = ("the ", "a ", "an ", "le ", "la ", "les ")

# "Tom 3", "Etap piąty", "Księga II", "#4", "vol. 4", "part 2" ... -> a number.
# A volume keyword optionally followed by punctuation/space, then a number or roman numeral.
_VOLUME_WORDS = re.compile(
    r"(?:tom|etap|księga|ksiega|vol|volume|part|część|czesc|#)\.?\s*([0-9]+|[ivxlcdm]+)\b",
    re.IGNORECASE,
)

# Polish ordinal words used for "Etap piąty" style volume labels.
_PL_ORDINALS = {
    "pierwszy": 1,
    "pierwsza": 1,
    "drugi": 2,
    "druga": 2,
    "trzeci": 3,
    "trzecia": 3,
    "czwarty": 4,
    "czwarta": 4,
    "piąty": 5,
    "piaty": 5,
    "piąta": 5,
    "piata": 5,
    "szósty": 6,
    "szosty": 6,
    "szósta": 6,
    "szosta": 6,
    "siódmy": 7,
    "siodmy": 7,
    "siódma": 7,
    "siodma": 7,
    "ósmy": 8,
    "osmy": 8,
    "dziewiąty": 9,
    "dziewiaty": 9,
    "dziesiąty": 10,
    "dziesiaty": 10,
}

_ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}


def _fold(text: str) -> str:
    """Casefold and strip accents (ł -> l handled explicitly; NFKD for the rest)."""
    text = text.replace("ł", "l").replace("Ł", "L")
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.casefold().strip()


def series_key(name: str | None) -> str:
    """Normalise a series name into a stable key. Empty name -> ""."""
    if not name:
        return ""
    folded = _fold(name)
    # Collapse punctuation to spaces, squeeze whitespace.
    folded = re.sub(r"[^\w\s]", " ", folded, flags=re.UNICODE)
    folded = re.sub(r"\s+", " ", folded).strip()
    for article in _ARTICLES:
        if folded.startswith(article):
            folded = folded[len(article) :]
            break
    return folded.strip()


def _roman_to_int(value: str) -> int | None:
    value = value.lower()
    if not value or any(ch not in _ROMAN for ch in value):
        return None
    total = 0
    prev = 0
    for ch in reversed(value):
        cur = _ROMAN[ch]
        total += cur if cur >= prev else -cur
        prev = cur
    return total or None


def parse_volume(label: str | None, *, title: str | None = None) -> float | None:
    """Extract a volume number from a volume label or a title.

    Handles a bare number ("4", "4.5"), "Tom 3", "Etap piąty", "#6", "Vol. 2",
    "Księga II" (roman) and the Polish ordinal words. Returns ``None`` when no
    number can be found.
    """
    for candidate in (label, title):
        number = _parse_volume_from(candidate)
        if number is not None:
            return number
    return None


def _parse_volume_from(text: str | None) -> float | None:
    if not text:
        return None
    raw = text.strip()
    # A bare numeric label ("4", "4.5", "6?").
    bare = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*\??\s*", raw)
    if bare:
        return float(bare.group(1))
    # Keyword + number / roman ("Tom 3", "vol. 4", "#6", "Księga II").
    match = _VOLUME_WORDS.search(raw)
    if match:
        token = match.group(1)
        if token.isdigit():
            return float(token)
        roman = _roman_to_int(token)
        if roman is not None:
            return float(roman)
    # Polish ordinal words ("Etap piąty").
    folded = _fold(raw)
    for word, number in _PL_ORDINALS.items():
        if re.search(rf"\b{word}\b", folded):
            return float(number)
    return None


def _is_read(book: Book) -> bool:
    return book.status.value == "finished" or book.finished_on is not None


def _volume_label(book: Book) -> str | None:
    return book.volume if book.volume else None


def build_alias_index(infos: list[SeriesInfo]) -> dict[str, str]:
    """Map every alias key -> canonical series_key, from the cached rows."""
    index: dict[str, str] = {}
    for info in infos:
        index[info.series_key] = info.series_key
        for alias in info.aliases:
            key = series_key(alias)
            if key:
                index[key] = info.series_key
    return index


def resolve_series_key(name: str, infos: list[SeriesInfo]) -> str:
    """Resolve a (possibly aliased) series name to its canonical key."""
    key = series_key(name)
    alias_index = build_alias_index(infos)
    return alias_index.get(key, key)


def compute_series(
    books: list[Book],
    infos: list[SeriesInfo] | None = None,
) -> list[SeriesSummary]:
    """Group books into series and compute reading data for each.

    ``infos`` (cached ``series_info`` rows) supply aliases, known volumes, total,
    the watch flag and the next-expected release. Books whose series matches an
    alias are folded into the canonical series.
    """
    infos = infos or []
    info_by_key: dict[str, SeriesInfo] = {i.series_key: i for i in infos}
    alias_index = build_alias_index(infos)

    # Canonical key -> display name (first non-empty series name seen).
    grouped: dict[str, list[Book]] = {}
    display: dict[str, str] = {}
    for book in books:
        if not book.series:
            continue
        key = series_key(book.series)
        canonical = alias_index.get(key, key)
        if not canonical:
            continue
        grouped.setdefault(canonical, []).append(book)
        display.setdefault(canonical, book.series)

    summaries: list[SeriesSummary] = []
    for key, series_books in grouped.items():
        info = info_by_key.get(key)
        name = info.display_name if info and info.display_name else display.get(key, key)
        author = _series_author(series_books, info)
        summaries.append(_summarise(key, name, author, series_books, info))

    summaries.sort(key=lambda s: s.name.casefold())
    return summaries


def _series_author(series_books: list[Book], info: SeriesInfo | None) -> str:
    if info and info.author:
        return info.author
    for book in series_books:
        if book.authors:
            return book.authors[0]
    return ""


def _summarise(
    key: str,
    name: str,
    author: str,
    series_books: list[Book],
    info: SeriesInfo | None,
) -> SeriesSummary:
    owned: list[OwnedVolume] = []
    owned_numbers: set[float] = set()
    for book in sorted(series_books, key=lambda b: (parse_volume(b.volume) or 0.0, b.title)):
        number = parse_volume(_volume_label(book))
        if number is not None:
            owned_numbers.add(number)
        read = _is_read(book)
        owned.append(
            OwnedVolume(
                book_id=book.id,
                volume=number,
                volume_label=_volume_label(book),
                title=book.title,
                cover_url=book.cover_url,
                status=book.status.value,
                read=read,
                favourite=bool(getattr(book, "favourite", False)),
                finished_on=book.finished_on.isoformat() if book.finished_on else None,
            )
        )

    owned_count = len(owned)
    read_count = sum(1 for o in owned if o.read)
    unread_owned = owned_count - read_count

    known = info.known_volumes if info else []
    missing = _missing_volumes(known, owned_numbers)
    total_known = _total_known(info, known, owned_numbers)

    started = any(o.status in ("reading", "finished") or o.read for o in owned)
    finished = _series_finished(owned, missing, total_known, read_count)
    section = _section(started, finished, unread_owned, missing)

    return SeriesSummary(
        series_key=key,
        name=name,
        author=author,
        aliases=info.aliases if info else [],
        owned_volumes=owned,
        missing_volumes=missing,
        owned_count=owned_count,
        read_count=read_count,
        unread_owned_count=unread_owned,
        total_known=total_known,
        section=section,
        started=started,
        finished=finished,
        watch=bool(info.watch) if info else False,
        next_expected=info.next_expected if info else None,
        last_checked=info.last_checked if info else None,
        notes=info.notes if info else None,
    )


def _missing_volumes(known: list[KnownVolume], owned_numbers: set[float]) -> list[MissingVolume]:
    missing: list[MissingVolume] = []
    for kv in known:
        if kv.number is None:
            continue
        if kv.number not in owned_numbers:
            missing.append(
                MissingVolume(
                    number=kv.number,
                    title=kv.title,
                    published_date=kv.published_date,
                    source=kv.source,
                )
            )
    missing.sort(key=lambda m: m.number if m.number is not None else 1e9)
    return missing


def _total_known(
    info: SeriesInfo | None,
    known: list[KnownVolume],
    owned_numbers: set[float],
) -> int | None:
    numbered_known = {kv.number for kv in known if kv.number is not None}
    all_numbers = numbered_known | owned_numbers
    if info and info.total_known:
        return max(info.total_known, len(all_numbers) or 0)
    if all_numbers:
        return len(all_numbers)
    return None


def _series_finished(
    owned: list[OwnedVolume],
    missing: list[MissingVolume],
    total_known: int | None,
    read_count: int,
) -> bool:
    """A series is complete when the user read every known volume and owns no unread one."""
    if not owned:
        return False
    if any(not o.read for o in owned):
        return False
    if missing:
        return False
    if total_known is not None and read_count < total_known:
        return False
    return True


def _section(
    started: bool,
    finished: bool,
    unread_owned: int,
    missing: list[MissingVolume],
) -> str:
    if finished:
        return "complete"
    if started:
        return "in_progress"
    return "owned"


def next_expected_from_known(
    known: list[KnownVolume],
    owned_numbers: set[float],
) -> NextExpected | None:
    """Pick the lowest-numbered known volume the user does not own, as 'next expected'."""
    candidates = [kv for kv in known if kv.number is not None and kv.number not in owned_numbers]
    if not candidates:
        return None
    candidates.sort(key=lambda kv: kv.number or 0.0)
    kv = candidates[0]
    return NextExpected(
        title=kv.title,
        date=kv.published_date,
        source_url=None,
        confidence="medium",
    )
