"""Series tracking & waiting-list endpoints. Thin controllers over the service."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status

from app.api.conditional import conditional_json
from app.api.deps import AppSettings, CurrentUser, DbConn
from app.schemas.series import (
    AlertsResponse,
    AlertsSeenRequest,
    ExpectedBook,
    ExpectedBookCreate,
    FoundVolumeAdd,
    SeriesBookAdd,
    SeriesBookVolume,
    SeriesCheckResult,
    SeriesMerge,
    SeriesPatch,
    SeriesRefresh,
    SeriesRename,
    SeriesSummary,
)
from app.services import series_service as service
from app.userdata import get_current_user_data

router = APIRouter(prefix="/series", tags=["series"])


@router.get("", response_model=list[SeriesSummary])
async def list_series(request: Request, user_id: CurrentUser, conn: DbConn) -> Response:
    """The user's series. Carries an ETag; a matching If-None-Match gets a 304 (no body)."""
    series = await service.list_series(conn, user_id)
    return conditional_json(request, series)


@router.get("/alerts", response_model=AlertsResponse)
async def series_alerts(user_id: CurrentUser, conn: DbConn) -> AlertsResponse:
    return await service.alerts(conn, user_id)


@router.post("/alerts/seen", response_model=AlertsResponse)
async def mark_alerts_seen(
    data: AlertsSeenRequest, user_id: CurrentUser, conn: DbConn
) -> AlertsResponse:
    """Mark Series-tab alerts as seen for the current user.

    Pass ``{"alert_keys": [...]}`` to dismiss those, or ``{"all": true}`` to dismiss every
    currently-unseen alert. Returns the refreshed alerts (with the new seen state) so the
    client can reconcile optimistic UI without a second request.
    """
    await service.mark_alerts_seen(conn, user_id, alert_keys=data.alert_keys, all_unseen=data.all)
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
    return await service.check_watched_series(
        settings=settings, user_id=user_id, user_data=get_current_user_data()
    )


@router.get("/{series_key}", response_model=SeriesSummary)
async def get_series(series_key: str, user_id: CurrentUser, conn: DbConn) -> SeriesSummary:
    summary = await service.get_series(conn, user_id, series_key)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary


@router.patch("/{series_key}", response_model=SeriesSummary)
async def patch_series(
    series_key: str,
    data: SeriesPatch,
    user_id: CurrentUser,
    conn: DbConn,
    background: BackgroundTasks,
    settings: AppSettings,
) -> SeriesSummary:
    """Edit a series. Only the fields present in the body are applied.

    Accepts the watch toggle (``watch``) and the editable metadata: ``display_name``,
    ``aliases``, ``author``, ``total_volumes``, ``notes``. To rename the series on every
    member book use ``POST /{series_key}/rename`` instead.

    Also accepts ``search_lang`` ('pl'|'en'|'both') to set the series' research language.
    Turning ``watch`` ON schedules a web release-research run as a background task and
    returns at once with ``checking=true``; the UI polls ``GET /{series_key}`` until the
    result lands. The research may run ONE Google Books lookup to auto-add a released volume.
    """
    summary = await service.update_series(
        conn,
        user_id,
        series_key,
        display_name=data.display_name,
        aliases=data.aliases,
        author=data.author,
        total_volumes=data.total_volumes,
        notes=data.notes,
        watch=data.watch,
        search_lang=data.search_lang,
    )
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    if data.watch is True:
        background.add_task(
            service.research_series_releases,
            user_id,
            summary.series_key,
            settings=settings,
            user_data=get_current_user_data(),
        )
    return summary


@router.post("/{series_key}/books", response_model=SeriesSummary)
async def add_series_book(
    series_key: str, data: SeriesBookAdd, user_id: CurrentUser, conn: DbConn
) -> SeriesSummary:
    """Add a library book to this series (sets book.series + book.volume; mirrors to JSON)."""
    summary = await service.add_book_to_series(
        conn, user_id, series_key, data.book_id, volume=data.volume
    )
    if summary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Series or book not found"
        )
    return summary


@router.delete("/{series_key}/books/{book_id}", response_model=SeriesSummary)
async def remove_series_book(
    series_key: str, book_id: int, user_id: CurrentUser, conn: DbConn
) -> SeriesSummary:
    """Remove a book from this series (clears book.series + book.volume; mirrors to JSON)."""
    summary = await service.remove_book_from_series(conn, user_id, series_key, book_id)
    if summary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Series or book not found"
        )
    return summary


@router.patch("/{series_key}/books/{book_id}", response_model=SeriesSummary)
async def patch_series_book(
    series_key: str,
    book_id: int,
    data: SeriesBookVolume,
    user_id: CurrentUser,
    conn: DbConn,
) -> SeriesSummary:
    """Change a member book's volume number within this series (mirrors to JSON)."""
    summary = await service.set_book_volume(conn, user_id, series_key, book_id, volume=data.volume)
    if summary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Series or book not found"
        )
    return summary


@router.post("/{series_key}/rename", response_model=SeriesSummary)
async def rename_series(
    series_key: str, data: SeriesRename, user_id: CurrentUser, conn: DbConn
) -> SeriesSummary:
    """Rename this series on every member book; the old name is kept as an alias."""
    summary = await service.rename_series(conn, user_id, series_key, data.name)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary


@router.post("/{series_key}/merge", response_model=SeriesSummary)
async def merge_series(
    series_key: str, data: SeriesMerge, user_id: CurrentUser, conn: DbConn
) -> SeriesSummary:
    """Merge another series into this one: its books move here, its names become aliases."""
    summary = await service.merge_series(conn, user_id, series_key, data.other_key)
    if summary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="One of the series was not found"
        )
    return summary


@router.post("/{series_key}/refresh", response_model=SeriesSummary)
async def refresh_series(
    series_key: str,
    user_id: CurrentUser,
    conn: DbConn,
    background: BackgroundTasks,
    settings: AppSettings,
    data: SeriesRefresh | None = None,
) -> SeriesSummary:
    """Re-run the web release-research step for one series.

    Accepts an optional body ``{"search_lang": "pl"|"en"|"both"}`` — a one-off language
    override that is also saved to the series. Schedules the research as a background task
    and returns at once with ``checking=true``; the UI polls ``GET /{series_key}`` for the
    result. Same step the watch toggle and ``POST /series/check`` use. May run ONE Google
    Books lookup to auto-add a released/announced volume.
    """
    search_lang = data.search_lang if data is not None else None
    if search_lang is not None:
        await service.update_series(conn, user_id, series_key, search_lang=search_lang)
    await service.mark_checking(conn, user_id, series_key, checking=True)
    summary = await service.get_series(conn, user_id, series_key)
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    background.add_task(
        service.research_series_releases,
        user_id,
        summary.series_key,
        search_lang=search_lang,
        settings=settings,
        user_data=get_current_user_data(),
    )
    return summary


@router.post("/{series_key}/volumes", response_model=SeriesSummary)
async def add_found_volume(
    series_key: str,
    data: FoundVolumeAdd,
    user_id: CurrentUser,
    conn: DbConn,
    settings: AppSettings,
) -> SeriesSummary:
    """Add one volume the research found (a gap or the next one) as 'want to read'.

    One Google Books query (cached, inside the call budget) fills the metadata; without a
    usable hit the book is added from the title. Used by the card's Add button.
    """
    summary = await service.add_found_volume(
        conn, user_id, series_key, data.title.strip(), data.volume, settings=settings
    )
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return summary
