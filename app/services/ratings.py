"""Rating orchestration: DB <-> rating engine."""

from __future__ import annotations

import aiosqlite

from app.repositories import books as repo
from app.schemas.books import Book
from app.services import rating


class ComparisonError(Exception):
    """A comparison referenced an unknown or unrated book."""


def group_of(book: Book) -> str | None:
    """A book's comparison group: its primary (first) shelf, falling back to its first category.

    Returns ``None`` when the book has neither a shelf nor a category -- such a book is only ever
    compared with other uncategorised books, never across categories (brief, wave 3, task 2).
    """
    if book.shelves:
        return book.shelves[0]
    if book.categories:
        return book.categories[0]
    return None


async def recompute(conn: aiosqlite.Connection, user_id: int) -> dict[int, rating.Score]:
    """Refit every rated book from its stars and the comparison log, then store the scores."""
    books = await repo.list_books(conn, user_id)
    stars = {b.id: b.stars for b in books if b.stars is not None}
    scores = rating.fit(stars, await repo.list_comparisons(conn, user_id))
    rows: list[tuple[int, float | None, float | None, float | None, int]] = [
        (s.book_id, s.latent, s.uncertainty, s.display, s.comparisons) for s in scores.values()
    ]
    # Unrated books lose any stale score.
    rows += [(b.id, None, None, None, 0) for b in books if b.stars is None]
    await repo.set_scores(conn, user_id, rows)
    return scores


async def suggest_pair(
    conn: aiosqlite.Connection,
    user_id: int,
    focus: int | None = None,
    group: str | None = None,
) -> tuple[Book, Book] | None:
    """Suggest the next comparison pair.

    Pairs are always drawn from a single category: each book's group is its primary shelf (or its
    first category, or ``None`` when it has neither), and a pair must share one group. When
    ``group`` is given, only books in that group are eligible; otherwise the engine picks the most
    informative pair that happens to share a group. ``focus`` restricts to pairs containing that
    book.
    """
    all_books = {b.id: b for b in await repo.list_books(conn, user_id) if b.stars is not None}
    groups = {i: group_of(b) for i, b in all_books.items()}

    if group is not None:
        books = {i: b for i, b in all_books.items() if groups[i] == group}
    else:
        books = all_books

    star_map = {i: b.stars for i, b in books.items() if b.stars is not None}
    scores = rating.fit(star_map, await repo.list_comparisons(conn, user_id))
    if focus is not None and focus not in scores:
        focus = None
    group_map = {i: groups[i] for i in scores}
    asked = {(left, right) for left, right, _ in await repo.list_comparisons(conn, user_id)}
    pair = rating.next_pair(
        scores, star_map, focus=focus, exclude=asked, groups=group_map
    ) or rating.next_pair(scores, star_map, focus=focus, groups=group_map)
    if pair is None:
        return None
    return books[pair[0]], books[pair[1]]


async def suggest_pairs(
    conn: aiosqlite.Connection,
    user_id: int,
    focus: int | None,
    group: str | None,
    count: int,
    skip: set[tuple[int, int]] | None = None,
) -> list[tuple[Book, Book]]:
    """Up to ``count`` distinct pairs from one model fit (for the ranking page's prefetch queue).

    ``skip`` holds pairs the client already has queued, so a refill never repeats them.
    Pairs already compared are avoided first, like :func:`suggest_pair`.
    """
    all_books = {b.id: b for b in await repo.list_books(conn, user_id) if b.stars is not None}
    groups = {i: group_of(b) for i, b in all_books.items()}
    books = (
        {i: b for i, b in all_books.items() if groups[i] == group} if group is not None else all_books
    )
    star_map = {i: b.stars for i, b in books.items() if b.stars is not None}
    comparisons = await repo.list_comparisons(conn, user_id)
    scores = rating.fit(star_map, comparisons)
    if focus is not None and focus not in scores:
        focus = None
    group_map = {i: groups[i] for i in scores}
    queued = {tuple(sorted(p)) for p in (skip or set())}
    asked = {tuple(sorted((left, right))) for left, right, _ in comparisons}

    result: list[tuple[Book, Book]] = []
    for avoid in (asked | queued, queued):
        while len(result) < count:
            taken = {tuple(sorted((a.id, b.id))) for a, b in result}
            pair = rating.next_pair(
                scores, star_map, focus=focus, exclude=avoid | taken, groups=group_map
            )
            if pair is None:
                break
            result.append((books[pair[0]], books[pair[1]]))
        if len(result) >= count:
            break
    return result


async def compare(
    conn: aiosqlite.Connection,
    user_id: int,
    session_id: str,
    left_id: int,
    right_id: int,
    winner: str,
) -> dict[int, rating.Score]:
    if left_id == right_id:
        raise ComparisonError("a book cannot be compared with itself")
    for book_id in (left_id, right_id):
        book = await repo.get_book(conn, user_id, book_id)
        if book is None or book.stars is None:
            raise ComparisonError(f"book {book_id} is missing or has no star rating")
    await repo.add_comparison(conn, user_id, session_id, left_id, right_id, winner)
    return await recompute(conn, user_id)
