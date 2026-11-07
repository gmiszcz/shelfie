"""Unit tests for the pure series computation (app.services.series)."""

from __future__ import annotations

from datetime import date

from app.schemas.books import Book, ReadingStatus
from app.schemas.series import KnownVolume, SeriesInfo
from app.services import series as compute


def _book(
    book_id: int,
    title: str,
    series: str | None,
    volume: str | None,
    *,
    status: str = "finished",
    finished: str | None = "2020-01-01",
    authors: list[str] | None = None,
    favourite: bool = False,
) -> Book:
    return Book(
        id=book_id,
        title=title,
        series=series,
        volume=volume,
        status=ReadingStatus(status),
        finished_on=date.fromisoformat(finished) if finished else None,
        authors=authors or ["An Author"],
        favourite=favourite,
        added_at="2020-01-01T00:00:00",
        updated_at="2020-01-01T00:00:00",
    )


def test_series_key_normalises_case_accents_and_articles() -> None:
    assert compute.series_key("The Way of the Shaman") == "way of the shaman"
    assert compute.series_key("the way of the shaman") == "way of the shaman"
    assert compute.series_key("Droga Szamana") == "droga szamana"
    # Accent + punctuation folding.
    assert compute.series_key("Żniwiarz!") == "zniwiarz"


def test_parse_volume_handles_numbers_words_and_roman() -> None:
    assert compute.parse_volume("3") == 3.0
    assert compute.parse_volume("Tom 3") == 3.0
    assert compute.parse_volume("#6") == 6.0
    assert compute.parse_volume("vol. 4") == 4.0
    assert compute.parse_volume("Księga II") == 2.0
    assert compute.parse_volume(None, title="Etap piąty") == 5.0
    assert compute.parse_volume("", title="Szachy Karmadonta. Etap piąty") == 5.0
    assert compute.parse_volume("not a volume") is None


def test_owned_read_and_missing_volumes() -> None:
    # Owns vols 1, 2, 3 (1-2 read, 3 unread); known total 5 -> missing 4 and 5.
    books = [
        _book(1, "Vol One", "Saga", "1", status="finished"),
        _book(2, "Vol Two", "Saga", "2", status="finished"),
        _book(3, "Vol Three", "Saga", "3", status="reading", finished=None),
    ]
    info = SeriesInfo(
        series_key="saga",
        display_name="Saga",
        known_volumes=[
            KnownVolume(number=1, title="Vol One"),
            KnownVolume(number=2, title="Vol Two"),
            KnownVolume(number=3, title="Vol Three"),
            KnownVolume(number=4, title="Vol Four"),
            KnownVolume(number=5, title="Vol Five"),
        ],
        total_known=5,
    )
    [summary] = compute.compute_series(books, [info])
    assert summary.owned_count == 3
    assert summary.read_count == 2
    assert summary.unread_owned_count == 1
    assert summary.total_known == 5
    assert [m.number for m in summary.missing_volumes] == [4.0, 5.0]
    assert summary.section == "in_progress"
    assert summary.started is True
    assert summary.finished is False


def test_complete_series_when_all_known_read_and_none_missing() -> None:
    books = [
        _book(1, "A", "Done", "1", status="finished"),
        _book(2, "B", "Done", "2", status="finished"),
    ]
    info = SeriesInfo(
        series_key="done",
        display_name="Done",
        known_volumes=[KnownVolume(number=1), KnownVolume(number=2)],
        total_known=2,
    )
    [summary] = compute.compute_series(books, [info])
    assert summary.section == "complete"
    assert summary.finished is True
    assert summary.missing_volumes == []


def test_alias_folds_two_names_into_one_series() -> None:
    # Two books under different names resolve to one series via the alias.
    books = [
        _book(1, "Legends of Ahn", "King's Dark Tidings", "3"),
        _book(2, "Kingdom of Madness", "Kroniki Mroku", "4"),
    ]
    info = SeriesInfo(
        series_key=compute.series_key("King's Dark Tidings"),
        display_name="King's Dark Tidings",
        aliases=["Kroniki Mroku"],
    )
    summaries = compute.compute_series(books, [info])
    assert len(summaries) == 1
    assert summaries[0].owned_count == 2
    assert summaries[0].name == "King's Dark Tidings"


def test_resolve_series_key_matches_alias() -> None:
    canonical = compute.series_key("King's Dark Tidings")
    info = SeriesInfo(
        series_key=canonical,
        display_name="King's Dark Tidings",
        aliases=["Kroniki Mroku"],
    )
    assert compute.resolve_series_key("Kroniki Mroku", [info]) == canonical
    assert compute.resolve_series_key("King's Dark Tidings", [info]) == canonical


def test_next_expected_from_known_picks_lowest_unowned() -> None:
    known = [KnownVolume(number=1), KnownVolume(number=2, title="Second"), KnownVolume(number=3)]
    nxt = compute.next_expected_from_known(known, owned_numbers={1.0, 3.0})
    assert nxt is not None
    assert nxt.title == "Second"


def test_gaps_in_owned_numbering_are_missing_volumes() -> None:
    # Owning volumes 3 and 5 (both read) means 1, 2 and 4 exist and are missing:
    # the series is in progress, never "complete" (e.g. Kel Kade, King's Dark Tidings).
    books = [
        _book(1, "Legends of Ahn", "King's Dark Tidings", "3"),
        _book(2, "Dragons and Demons", "King's Dark Tidings", "5"),
    ]
    [summary] = compute.compute_series(books, [])
    assert [m.number for m in summary.missing_volumes] == [1.0, 2.0, 4.0]
    assert summary.section != "complete"
    assert summary.finished is False
    assert summary.total_known == 5
