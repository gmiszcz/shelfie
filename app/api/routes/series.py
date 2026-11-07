"""Series tracking & waiting-list endpoints. Thin controllers over the service."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import AppSettings, CurrentUser, DbConn
from app.schemas.series import (
    AlertsResponse,
    ExpectedBook,
    ExpectedBookCreate,
    SeriesCheckResult,
    SeriesSummary,
    WatchPatch,
)
from app.services import series_service as service

router = APIRouter(prefix="/series", tags=["series"])


@router.get("", response_model=list[SeriesSummary])
async def list_series(user_id: CurrentUser, conn: DbConn) -> list[SeriesSummary]:
    return await service.list_series(conn, user_id)


@router.get("/alerts", response_model=AlertsResponse)
async def series_alerts(user_id: CurrentUser, conn: DbConn) -> AlertsResponse:
    return await service.alerts(conn, user_id)


# --- waiting list (declared before /{series_key} so the literal path wins) ---------------


@router.get("/expected", response_model=list[ExpectedBook])
async def list_expected(user_id: CurrentUser, conn: DbConn) -> list[ExpectedBook]:
    return await service.list_expected(conn, user_id)


@router.post("/expected", response_model=ExpectedBook, status_code=status.HTTP_201_CREATED)
async def add_expected(
    data: ExpectedBookCreate, user_id: CurrentUser, conn: DbConn
) -> ExpectedBook:
    return await service.add_expected(conn, user_id, data)


@router.delete("/expected/{expected_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expected(expected_id: int, user_id: CurrentUser, conn: DbConn) -> None:
    removed = await service.remove_expected(conn, user_id, expected_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


@router.post("/check", response_model=SeriesCheckResult)
async def check_series(
    user_id: CurrentUser, conn: DbConn, settings: AppSettings
) -> SeriesCheckResult:
    """Re-check every watched series now (manual trigger of the periodic checker)."""
    return await service.check_watched_series(settings=settings)


@router.get("/{series_key}", response_model=SeriesSummary)
async def get_series(series_key: str, user_id: CurrentUser, conn: DbConn) -> SeriesSummary:
    summary = await service.get_series(conn, user_id, series_key)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary


@router.patch("/{series_key}", response_model=SeriesSummary)
async def patch_series(
    series_key: str, data: WatchPatch, user_id: CurrentUser, conn: DbConn
) -> SeriesSummary:
    summary = await service.set_watch(conn, user_id, series_key, watch=data.watch)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary


@router.post("/{series_key}/refresh", response_model=SeriesSummary)
async def refresh_series(
    series_key: str, user_id: CurrentUser, conn: DbConn, settings: AppSettings
) -> SeriesSummary:
    summary = await service.refresh_series(conn, user_id, series_key, settings=settings)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary
