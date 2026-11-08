"""Pydantic models for series tracking and the waiting list (wave 5).

A *series* is derived from the user's books (every book whose ``series`` is set),
enriched with a cached ``series_info`` row that stores what the external lookups
found (known volumes, total, next expected release) plus the user's watch flag and
name aliases. Reading data (owned/read/missing) is always computed live from the
books; only the lookup cache and the watch flag are persisted.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


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


# The research language(s) a series is searched in. 'pl' (default) searches Polish
# publisher/retailer sites, 'en' the author site / Goodreads / Amazon, 'both' searches both.
SEARCH_LANGS = ("pl", "en", "both")


class ReleaseDetail(BaseModel):
    """One short factual bullet from the editor, each tied to the source it came from."""

    text: str
    source_url: str | None = None


class ReleaseEdition(BaseModel):
    """Per-language edition facts inside a :class:`ReleaseSummary`."""

    status: str | None = None  # released | announced | in_translation | no_news | unknown
    title: str | None = None
    date: str | None = None
    source_url: str | None = None


class ReleaseSummary(BaseModel):
    """The clean, editor-written release summary for a watched series (wave 6).

    One factual Polish ``headline`` sentence (the style of Google's AI answer), a coarse
    ``status``, the real next book ``next_title`` (never a mangled series-tagged string),
    its ``next_volume`` and a free-text ``expected_date``. ``details`` are short Polish
    bullets each with a source, ``editions`` carries per-language facts, ``added_book_id``
    is set once the auto-add put the book in the library, and ``checked_at`` is the run time.
    """

    status: str = "unknown"  # released | announced | in_translation | no_news | unknown
    headline: str = ""
    next_title: str | None = None
    next_volume: float | None = None
    expected_date: str | None = None
    details: list[ReleaseDetail] = Field(default_factory=list)
    editions: dict[str, ReleaseEdition] = Field(default_factory=dict)
    added_book_id: int | None = None
    checked_at: str | None = None


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
    search_lang: str = "pl"
    release_summary: ReleaseSummary | None = None
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
    search_lang: str = "pl"
    release_summary: ReleaseSummary | None = None
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
    # The research language for this series: 'pl' | 'en' | 'both'.
    search_lang: str | None = None

    @field_validator("search_lang")
    @classmethod
    def valid_search_lang(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value not in SEARCH_LANGS:
            raise ValueError(f"search_lang must be one of {SEARCH_LANGS}")
        return value


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
    # Stable identity of this alert (kind + series + the fields that matter, e.g. the
    # release date). Dismissing stores this key; a NEW alert gets a different key and
    # therefore reappears. See app.services.series_service._alert_key.
    alert_key: str = ""
    # Whether the user has already dismissed THIS exact alert (this key is in alert_seen).
    seen: bool = False


class AlertsResponse(BaseModel):
    # ``count`` is the number of UNSEEN alerts (the badge value); kept named ``count`` for
    # backward compatibility with existing callers. ``unseen_count`` is the same number
    # under an explicit name. ``in_progress`` / ``new_volume`` carry EVERY alert (seen and
    # unseen) each with its ``seen`` flag, so the UI can show unseen by default and reveal
    # seen ones on demand.
    count: int
    unseen_count: int = 0
    in_progress: list[SeriesAlert] = Field(default_factory=list)
    new_volume: list[SeriesAlert] = Field(default_factory=list)


class AlertsSeenRequest(BaseModel):
    """POST body for marking Series-tab alerts as seen.

    Either pass explicit ``alert_keys`` to dismiss those, or ``all=true`` to dismiss every
    currently-unseen alert.
    """

    alert_keys: list[str] = Field(default_factory=list)
    all: bool = False


class SeriesPreferences(BaseModel):
    """Per-user Series-tab UI preferences (stored in ``ui_prefs`` under key 'series')."""

    # The active filter on the Series tab. One of the SERIES_FILTERS ids below.
    filter: str = "all"
    # Optional sort choice (reserved; the UI may ignore it). Kept so the prefs endpoint
    # can carry it without a schema change.
    sort: str | None = None
    # Default research language for a newly-watched series ('pl' | 'en' | 'both').
    default_search_lang: str = "pl"

    @field_validator("default_search_lang")
    @classmethod
    def valid_default_search_lang(cls, value: str) -> str:
        return value if value in SEARCH_LANGS else "pl"


class SeriesRefresh(BaseModel):
    """Optional POST /api/series/{key}/refresh body: a one-off language override.

    When ``search_lang`` is given it is applied to the series (saved) and used for this
    research run; absent, the series' stored ``search_lang`` is used.
    """

    search_lang: str | None = None

    @field_validator("search_lang")
    @classmethod
    def valid_search_lang(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value not in SEARCH_LANGS:
            raise ValueError(f"search_lang must be one of {SEARCH_LANGS}")
        return value


class SeriesCheckResult(BaseModel):
    """Result of a POST /api/series/check (or /refresh) run."""

    checked: int
    updated: int
    series: list[str] = Field(default_factory=list)
    notes: str | None = None
