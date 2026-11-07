"""Per-user UI preferences endpoints (series-ux).

A thin controller over the service, which reads/writes the ``ui_prefs`` table for the
current user. Preferences belong to the person (restored on any device), never to the
browser's localStorage.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUser, DbConn
from app.schemas.series import SeriesPreferences
from app.services import series_service as service

router = APIRouter(prefix="/preferences", tags=["preferences"])


@router.get("/series", response_model=SeriesPreferences)
async def get_series_preferences(user_id: CurrentUser, conn: DbConn) -> SeriesPreferences:
    """Return the current user's Series-tab preferences (defaults when never set)."""
    return await service.get_series_preferences(conn, user_id)


@router.put("/series", response_model=SeriesPreferences)
async def put_series_preferences(
    data: SeriesPreferences, user_id: CurrentUser, conn: DbConn
) -> SeriesPreferences:
    """Persist the current user's Series-tab preferences (active filter, optional sort)."""
    return await service.set_series_preferences(conn, user_id, data)
