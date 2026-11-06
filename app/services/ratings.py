"""Rating orchestration: DB <-> rating engine."""

from __future__ import annotations

import aiosqlite

from app.repositories import books as repo
from app.schemas.books import Book
from app.services import rating


class ComparisonError(Exception):
    """A comparison referenced an unknown or unrated book."""


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
    conn: aiosqlite.Connection, user_id: int, focus: int | None = None
) -> tuple[Book, Book] | None:
    books = {b.id: b for b in await repo.list_books(conn, user_id) if b.stars is not None}
    star_map = {i: b.stars for i, b in books.items() if b.stars is not None}
    scores = rating.fit(star_map, await repo.list_comparisons(conn, user_id))
    if focus is not None and focus not in scores:
        focus = None
    asked = {(left, right) for left, right, _ in await repo.list_comparisons(conn, user_id)}
    pair = rating.next_pair(scores, star_map, focus=focus, exclude=asked) or rating.next_pair(
        scores, star_map, focus=focus
    )
    if pair is None:
        return None
    return books[pair[0]], books[pair[1]]


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
