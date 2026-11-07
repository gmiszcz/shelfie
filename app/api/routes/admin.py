"""Admin endpoints: manage accounts. Every route requires an admin session.

``setup_url`` values are built from the request's own origin so a link copied from the
admin UI points back at the same host the admin is using.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import AdminUser, AppSettings, AuthConn
from app.authdb import AuthUser
from app.config import Settings
from app.schemas.auth import (
    AdminUserCreate,
    AdminUserCreated,
    AdminUserOut,
    AdminUserPatch,
    SetupLinkOut,
    UserOut,
)
from app.services import auth_service
from app.services.auth_service import AuthError, user_data_for

router = APIRouter(prefix="/admin", tags=["admin"])


def _origin(request: Request, settings: Settings) -> str:
    """The browser-facing origin the admin is using: ``<scheme>://<host>``.

    Prefers the ``Origin`` header (the CSRF middleware has already checked it matches
    the host). Otherwise uses the first ``X-Forwarded-Host``/``-Proto`` hop, because
    the Vite dev proxy (changeOrigin) rewrites ``Host`` to the backend's own address.
    """
    origin = request.headers.get("origin", "").strip()
    if origin and origin != "null":
        return origin.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    scheme = proto or request.url.scheme
    fwd_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    host = fwd_host or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}"


async def _admin_out(settings: Settings, user: AuthUser) -> AdminUserOut:
    count = await auth_service.book_count(user_data_for(settings, user.id))
    return AdminUserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_admin=user.is_admin,
        disabled=user.disabled,
        has_password=user.has_password,
        created_at=user.created_at,
        book_count=count,
    )


@router.get("/users", response_model=list[AdminUserOut])
async def list_users(
    _admin: AdminUser, settings: AppSettings, auth_conn: AuthConn
) -> list[AdminUserOut]:
    from app import authdb

    users = await authdb.list_users(auth_conn)
    return [await _admin_out(settings, u) for u in users]


@router.post("/users", response_model=AdminUserCreated, status_code=status.HTTP_201_CREATED)
async def create_user(
    data: AdminUserCreate,
    request: Request,
    _admin: AdminUser,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> AdminUserCreated:
    try:
        user = await auth_service.create_account(
            auth_conn, settings, email=data.email, display_name=data.display_name
        )
    except auth_service.EmailTaken as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.args[0]) from exc
    setup_url, expires = await auth_service.issue_setup_link(
        auth_conn, settings, user_id=user.id, purpose="setup", origin=_origin(request, settings)
    )
    return AdminUserCreated(
        user=UserOut(
            id=user.id, email=user.email, display_name=user.display_name, is_admin=user.is_admin
        ),
        setup_url=setup_url,
        expires_at=expires.isoformat(),
    )


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def patch_user(
    user_id: int,
    data: AdminUserPatch,
    _admin: AdminUser,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> AdminUserOut:
    try:
        updated = await auth_service.set_user_flags(
            auth_conn,
            user_id=user_id,
            display_name=data.display_name,
            disabled=data.disabled,
            is_admin=data.is_admin,
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.args[0]) from exc
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return await _admin_out(settings, updated)


@router.post("/users/{user_id}/setup-link", response_model=SetupLinkOut)
async def new_setup_link(
    user_id: int,
    request: Request,
    _admin: AdminUser,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> SetupLinkOut:
    from app import authdb

    user = await authdb.get_user(auth_conn, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    setup_url, expires = await auth_service.issue_setup_link(
        auth_conn, settings, user_id=user_id, purpose="reset", origin=_origin(request, settings)
    )
    return SetupLinkOut(setup_url=setup_url, expires_at=expires.isoformat())
