"""Reading statistics: read books in a date range, grouped for bar charts."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from enum import Enum

from pydantic import BaseModel

from app.schemas.books import Book, ReadingStatus

UNGROUPED = "—"


class GroupBy(str, Enum):
    shelf = "shelf"
    tag = "tag"
    month = "month"
    year = "year"


class Bucket(BaseModel):
    key: str
    books: int
    pages: int


class StatsSummary(BaseModel):
    books: int
    pages: int
    average_stars: float | None
    first_finished: str | None
    last_finished: str | None


class StatsResponse(BaseModel):
    date_from: date | None
    date_to: date | None
    group_by: GroupBy
    summary: StatsSummary
    buckets: list[Bucket]
    books: list[Book]


def finished_in_range(
    books: list[Book], date_from: date | None, date_to: date | None
) -> list[Book]:
    """Books marked finished with a finish date inside [date_from, date_to]."""
    out: list[Book] = []
    for book in books:
        if book.status != ReadingStatus.finished or book.finished_on is None:
            continue
        if date_from and book.finished_on < date_from:
            continue
        if date_to and book.finished_on > date_to:
            continue
        out.append(book)
    return sorted(out, key=lambda b: b.finished_on or date.min, reverse=True)


def _pages(book: Book) -> int:
    return book.page_count or book.pages_read or 0


def group(books: list[Book], by: GroupBy) -> list[Bucket]:
    counts: Counter[str] = Counter()
    pages: dict[str, int] = defaultdict(int)

    def add(key: str, book: Book) -> None:
        counts[key] += 1
        pages[key] += _pages(book)

    for book in books:
        if by is GroupBy.shelf:
            for key in book.shelves or [UNGROUPED]:
                add(key, book)
        elif by is GroupBy.tag:
            for key in book.tags or [UNGROUPED]:
                add(key, book)
        elif book.finished_on is not None:
            fmt = "%Y-%m" if by is GroupBy.month else "%Y"
            add(book.finished_on.strftime(fmt), book)

    buckets = [Bucket(key=k, books=counts[k], pages=pages[k]) for k in counts]
    if by in (GroupBy.month, GroupBy.year):
        return sorted(buckets, key=lambda b: b.key)
    return sorted(buckets, key=lambda b: (-b.books, b.key))


def summarize(books: list[Book]) -> StatsSummary:
    rated = [b.stars for b in books if b.stars is not None]
    dates = sorted(b.finished_on for b in books if b.finished_on is not None)
    return StatsSummary(
        books=len(books),
        pages=sum(_pages(b) for b in books),
        average_stars=round(sum(rated) / len(rated), 2) if rated else None,
        first_finished=dates[0].isoformat() if dates else None,
        last_finished=dates[-1].isoformat() if dates else None,
    )


def build(
    books: list[Book], date_from: date | None, date_to: date | None, by: GroupBy
) -> StatsResponse:
    selected = finished_in_range(books, date_from, date_to)
    return StatsResponse(
        date_from=date_from,
        date_to=date_to,
        group_by=by,
        summary=summarize(selected),
        buckets=group(selected, by),
        books=selected,
    )
