"""CSRF protection for the API.

``SameSite=Lax`` on the session cookie already blocks most cross-site writes. On top of
that, every state-changing request (``POST``/``PUT``/``PATCH``/``DELETE``) to ``/api/*``
must carry the header ``X-Shelfie-Client: web`` (the frontend adds it to every request) or
it is rejected with ``403``. When an ``Origin`` header is present it must match the request
host. See ``docs/features/auth.md``.
"""

from __future__ import annotations

from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

STATE_CHANGING = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CLIENT_HEADER = "x-shelfie-client"
CLIENT_VALUE = "web"

# State-changing public routes that the client sends before it has any session; the header
# is still required, but these never need a session cookie.
_API_PREFIX = "/api/"


class CsrfMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        if request.method in STATE_CHANGING and path.startswith(_API_PREFIX):
            # Require the custom client header.
            if request.headers.get(CLIENT_HEADER, "").strip().lower() != CLIENT_VALUE:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Missing or invalid X-Shelfie-Client header"},
                )
            # When an Origin is present, its host must match the request host.
            origin = request.headers.get("origin")
            if origin:
                origin_host = urlparse(origin).netloc
                request_host = request.headers.get("host") or request.url.netloc
                if origin_host and request_host and origin_host != request_host:
                    return JSONResponse(
                        status_code=403, content={"detail": "Origin does not match host"}
                    )
        response: Response = await call_next(request)
        return response
