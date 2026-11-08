"""Authentication endpoints: login, logout, me, password change, setup links.

Public routes: ``POST /login``, ``POST /register``, ``GET /config``, ``POST /setup``,
``GET /setup/{token}`` (plus ``GET /api/health``). Everything else needs a valid session cookie. The session cookie is
set here on login/setup and cleared on logout; its flags follow ``docs/features/auth.md``.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status

from app.api.deps import AppSettings, AuthConn, CurrentAuthUser, client_ip
from app.config import Settings
from app.schemas.auth import (
    AuthConfigOut,
    LoginIn,
    PasswordChangeIn,
    ProfilePatch,
    RegisterIn,
    SetupCompleteIn,
    SetupInfo,
    UserOut,
)
from app.services import auth_service
from app.services.auth_service import SESSION_COOKIE, AuthError, LoginResult

router = APIRouter(prefix="/auth", tags=["auth"])


def _is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return proto == "https" or request.url.scheme == "https"


def _cookie_secure(settings: Settings, request: Request) -> bool:
    if settings.cookie_secure == "true":
        return True
    if settings.cookie_secure == "false":
        return False
    return _is_https(request)


def _set_session_cookie(
    response: Response, settings: Settings, request: Request, result: LoginResult
) -> None:
    max_age = settings.session_days * 24 * 3600
    response.set_cookie(
        key=SESSION_COOKIE,
        value=result.token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(settings, request),
        path="/",
    )


def _user_out(user: auth_service.AuthUser) -> UserOut:
    return UserOut(
        id=user.id, email=user.email, display_name=user.display_name, is_admin=user.is_admin
    )


@router.post("/login", response_model=UserOut)
async def login(
    data: LoginIn,
    request: Request,
    response: Response,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> UserOut:
    try:
        result = await auth_service.login(
            auth_conn,
            settings,
            email=data.email,
            password=data.password,
            user_agent=request.headers.get("user-agent"),
            ip=client_ip(request),
        )
    except auth_service.Throttled as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=exc.args[0],
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=exc.args[0]) from exc
    _set_session_cookie(response, settings, request, result)
    return _user_out(result.user)


@router.get("/config", response_model=AuthConfigOut)
async def auth_config(settings: AppSettings) -> AuthConfigOut:
    """What the login screen needs before anyone is logged in."""
    return AuthConfigOut(
        registration_enabled=settings.registration_enabled,
        password_min_length=settings.password_min_length,
    )


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(
    data: RegisterIn,
    request: Request,
    response: Response,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> UserOut:
    try:
        result = await auth_service.register(
            auth_conn,
            settings,
            email=data.email,
            display_name=data.display_name,
            password=data.password,
            user_agent=request.headers.get("user-agent"),
            ip=client_ip(request),
        )
    except auth_service.Throttled as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=exc.args[0],
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except auth_service.RegistrationClosed as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=exc.args[0]) from exc
    except auth_service.EmailTaken as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.args[0]) from exc
    except auth_service.WeakPassword as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.args[0]
        ) from exc
    _set_session_cookie(response, settings, request, result)
    return _user_out(result.user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request, response: Response, settings: AppSettings, auth_conn: AuthConn
) -> Response:
    await auth_service.logout(auth_conn, request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserOut)
async def me(user: CurrentAuthUser, settings: AppSettings, background: BackgroundTasks) -> UserOut:
    # The app calls /me once when it opens: a good moment to re-check watched series
    # (only if the last check is older than 24 h). Runs after the response is sent.
    from app.services import series_service

    background.add_task(
        series_service.auto_check_if_stale,
        auth_service.user_data_for(settings, user.id),
        settings=settings,
    )
    return _user_out(user)


@router.patch("/me", response_model=UserOut)
async def update_me(data: ProfilePatch, auth_conn: AuthConn, user: CurrentAuthUser) -> UserOut:
    updated = await auth_service.update_profile(
        auth_conn, user=user, display_name=data.display_name
    )
    return _user_out(updated)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    data: PasswordChangeIn,
    request: Request,
    settings: AppSettings,
    auth_conn: AuthConn,
    user: CurrentAuthUser,
) -> Response:
    try:
        await auth_service.change_password(
            auth_conn,
            settings,
            user=user,
            current_password=data.current_password,
            new_password=data.new_password,
            current_token=request.cookies.get(SESSION_COOKIE),
        )
    except auth_service.InvalidCredentials as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is wrong"
        ) from exc
    except auth_service.WeakPassword as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.args[0]
        ) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/setup/{token}", response_model=SetupInfo)
async def read_setup(token: str, auth_conn: AuthConn) -> SetupInfo:
    try:
        user, purpose = await auth_service.read_setup_token(auth_conn, token)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=exc.args[0]) from exc
    return SetupInfo(email=user.email, display_name=user.display_name, purpose=purpose)


@router.post("/setup", response_model=UserOut)
async def complete_setup(
    data: SetupCompleteIn,
    request: Request,
    response: Response,
    settings: AppSettings,
    auth_conn: AuthConn,
) -> UserOut:
    try:
        result = await auth_service.complete_setup(
            auth_conn,
            settings,
            token=data.token,
            password=data.password,
            user_agent=request.headers.get("user-agent"),
            ip=client_ip(request),
        )
    except auth_service.TokenInvalid as exc:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=exc.args[0]) from exc
    except auth_service.WeakPassword as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.args[0]
        ) from exc
    _set_session_cookie(response, settings, request, result)
    return _user_out(result.user)
