"""Reading statistics endpoint."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import CurrentUser, DbConn
from app.services import books as books_service
from app.services import stats

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("", response_model=stats.StatsResponse)
async def reading_stats(
    user_id: CurrentUser,
    conn: DbConn,
    date_from: date | None = Query(default=None, description="Finished on or after (YYYY-MM-DD)"),
    date_to: date | None = Query(default=None, description="Finished on or before (YYYY-MM-DD)"),
    group_by: stats.GroupBy = Query(default=stats.GroupBy.month),
) -> stats.StatsResponse:
    if date_from and date_to and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_from must not be after date_to",
        )
    books = await books_service.list_library(conn, user_id)
    return stats.build(books, date_from, date_to, group_by)
