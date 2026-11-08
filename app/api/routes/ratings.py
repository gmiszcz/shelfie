"""Rating engine endpoints: manual recompute and pairwise comparisons."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, DbConn
from app.repositories import books as repo
from app.schemas.books import Book
from app.services import ratings

router = APIRouter(prefix="/ratings", tags=["ratings"])


class RecomputeResult(BaseModel):
    rated_books: int
    comparisons: int


class Pair(BaseModel):
    left: Book
    right: Book


class ComparisonIn(BaseModel):
    left_id: int
    right_id: int
    winner: Literal["left", "right", "tie"]
    session_id: str = Field(default="manual", max_length=64)


@router.post("/recompute", response_model=RecomputeResult)
async def recompute(user_id: CurrentUser, conn: DbConn) -> RecomputeResult:
    scores = await ratings.recompute(conn, user_id)
    return RecomputeResult(
        rated_books=len(scores), comparisons=await repo.count_comparisons(conn, user_id)
    )


@router.get(
    "/pair", response_model=Pair, responses={204: {"description": "Not enough rated books"}}
)
async def next_pair(
    user_id: CurrentUser, conn: DbConn, focus: int | None = None, group: str | None = None
) -> Pair | Response:
    pair = await ratings.suggest_pair(conn, user_id, focus, group)
    if pair is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return Pair(left=pair[0], right=pair[1])


@router.get("/pairs", response_model=list[Pair])
async def next_pairs(
    user_id: CurrentUser,
    conn: DbConn,
    focus: int | None = None,
    group: str | None = None,
    count: int = 3,
    skip: str = "",
) -> list[Pair]:
    """Up to ``count`` (max 5) distinct pairs for the client's prefetch queue.

    ``skip`` is a comma-separated list of ``leftId-rightId`` pairs the client already holds.
    """
    skipped: set[tuple[int, int]] = set()
    for token in skip.split(","):
        left, _, right = token.partition("-")
        if left.isdigit() and right.isdigit():
            skipped.add((int(left), int(right)))
    pairs = await ratings.suggest_pairs(conn, user_id, focus, group, max(1, min(count, 5)), skipped)
    return [Pair(left=a, right=b) for a, b in pairs]


@router.post("/compare", response_model=Pair)
async def compare(data: ComparisonIn, user_id: CurrentUser, conn: DbConn) -> Pair:
    try:
        await ratings.compare(
            conn, user_id, data.session_id, data.left_id, data.right_id, data.winner
        )
    except ratings.ComparisonError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    left = await repo.get_book(conn, user_id, data.left_id)
    right = await repo.get_book(conn, user_id, data.right_id)
    if left is None or right is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return Pair(left=left, right=right)
