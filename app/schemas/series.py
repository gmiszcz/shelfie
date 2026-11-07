"""Pydantic models for series tracking and the waiting list (wave 5).

A *series* is derived from the user's books (every book whose ``series`` is set),
enriched with a cached ``series_info`` row that stores what the external lookups
found (known volumes, total, next expected release) plus the user's watch flag and
name aliases. Reading data (owned/read/missing) is always computed live from the
books; only the lookup cache and the watch flag are persisted.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class KnownVolume(BaseModel):
    """One volume of a series as reported by an external source."""

    number: float | None = None
    title: str | None = None
    published_date: str | None = None
    source: str | None = None  # "google_books" | "openlibrary" | "manual" | "agent"


class NextExpected(BaseModel):
    """The next, not-yet-released or newest-found volume of a watched series."""

    title: str | None = None
    date: str | None = None
    source_url: str | None = None
    confidence: str | None = None  # "high" | "medium" | "low"
    status: str | None = None  # "announced" | "released" | "unknown"


class OwnedVolume(BaseModel):
    """A volume the user owns (a book in the library), as shown on a series card."""

    book_id: int
    volume: float | None = None
    volume_label: str | None = None
    title: str
    cover_url: str | None = None
    status: str
    read: bool
    favourite: bool = False
    finished_on: str | None = None


class MissingVolume(BaseModel):
    """A known volume the user does not own."""

    number: float | None = None
    title: str | None = None
    published_date: str | None = None
    source: str | None = None


class SeriesInfo(BaseModel):
    """The cached lookup row for a series (``series_info`` table)."""

    series_key: str
    display_name: str = ""
    author: str = ""
    aliases: list[str] = Field(default_factory=list)
    known_volumes: list[KnownVolume] = Field(default_factory=list)
    total_known: int | None = None
    watch: bool = False
    next_expected: NextExpected | None = None
    next_expected_pl: NextExpected | None = None
    next_expected_en: NextExpected | None = None
    checking: bool = False
    notes: str | None = None
    last_checked: str | None = None


class SeriesSummary(BaseModel):
    """A series as the Series tab shows it: computed reading data + cached lookup."""

    series_key: str
    name: str
    author: str
    aliases: list[str] = Field(default_factory=list)

    owned_volumes: list[OwnedVolume] = Field(default_factory=list)
    missing_volumes: list[MissingVolume] = Field(default_factory=list)

    owned_count: int = 0
    read_count: int = 0
    unread_owned_count: int = 0
    total_known: int | None = None

    # "in_progress" (started, not finished), "complete" (all known volumes read),
    # or "owned" (owns volumes but no clear in-progress/complete signal).
    section: str = "owned"
    started: bool = False
    finished: bool = False

    watch: bool = False
    next_expected: NextExpected | None = None
    next_expected_pl: NextExpected | None = None
    next_expected_en: NextExpected | None = None
    checking: bool = False
    last_checked: str | None = None
    notes: str | None = None


class SeriesPatch(BaseModel):
    """PATCH body for editing a series.

    Every field is optional: only the ones present in the request are applied, so the
    same endpoint keeps serving the watch toggle (``watch`` alone) and the full edit
    (display name, aliases, author, total volumes, notes). ``display_name`` renames the
    cached row's name only; to rename the series on every member book use the dedicated
    ``/rename`` endpoint.
    """

    watch: bool | None = None
    display_name: str | None = Field(default=None, max_length=500)
    aliases: list[str] | None = None
    author: str | None = Field(default=None, max_length=500)
    total_volumes: int | None = Field(default=None, ge=0, le=10_000)
    notes: str | None = None


class WatchPatch(BaseModel):
    """PATCH body for the watch toggle."""

    watch: bool


class SeriesBookAdd(BaseModel):
    """POST body to add a library book to a series."""

    book_id: int
    volume: str | None = None


class SeriesBookVolume(BaseModel):
    """PATCH body to change a member book's volume number."""

    volume: str | None = None


class SeriesRename(BaseModel):
    """POST body to rename a series on every member book (old name kept as an alias)."""

    name: str = Field(min_length=1, max_length=500)


class SeriesMerge(BaseModel):
    """POST body to merge another series into this one."""

    other_key: str = Field(min_length=1)


class ExpectedBook(BaseModel):
    """A not-yet-owned upcoming book on the waiting list."""

    id: int
    title: str
    author: str = ""
    series_key: str | None = None
    series_name: str | None = None
    volume: str | None = None
    expected_date: str | None = None
    source_url: str | None = None
    source: str | None = None
    confidence: str | None = None
    notes: str | None = None


class ExpectedBookCreate(BaseModel):
    """Create body for a waiting-list entry (``add_expected_book``)."""

    title: str = Field(min_length=1, max_length=500)
    author: str = ""
    series_name: str | None = None
    volume: str | None = None
    expected_date: str | None = None
    source_url: str | None = None
    source: str | None = None
    confidence: str | None = None
    notes: str | None = None


class SeriesAlert(BaseModel):
    """One notification item for the Series tab badge / alert list."""

    kind: str  # "in_progress" | "new_volume"
    series_key: str
    series_name: str
    message: str
    detail: str | None = None
    source_url: str | None = None


class AlertsResponse(BaseModel):
    count: int
    in_progress: list[SeriesAlert] = Field(default_factory=list)
    new_volume: list[SeriesAlert] = Field(default_factory=list)


class SeriesCheckResult(BaseModel):
    """Result of a POST /api/series/check (or /refresh) run."""

    checked: int
    updated: int
    series: list[str] = Field(default_factory=list)
    notes: str | None = None
