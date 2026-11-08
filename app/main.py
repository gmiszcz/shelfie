"""FastAPI application: lifespan, CORS, routing, static frontend mount."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from app import __version__
from app.api.middleware import CsrfMiddleware
from app.api.router import api_router
from app.authdb import init_auth_db
from app.config import Settings, get_settings
from app.logging_config import configure_logging


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    # Only the shared auth database is created at startup. Each user's library DB is
    # created on first access (see app.api.deps.current_user). There is no global library.
    settings.data_path.mkdir(parents=True, exist_ok=True)
    await init_auth_db(settings.auth_database_file)
    yield


class SpaStaticFiles(StaticFiles):
    """Static files with a single-page-app fallback.

    A client-side route such as ``/setup?token=...`` has no file on disk; serve
    ``index.html`` so a reload or a pasted link opens the app. ``/api/*`` and real
    asset paths (with a file extension) still 404 normally.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path.startswith("api") or "." in path.rsplit("/", 1)[-1]:
                raise
            return await super().get_response("index.html", scope)


def _export_bedrock_token(settings: Settings) -> None:
    """Expose the Bedrock API key from .env to boto3, which reads it from the process env.

    pydantic-settings loads .env into Settings only, not os.environ, so without this every
    Bedrock client would fall back to SSO. An env var already set wins.
    """
    token = settings.aws_bearer_token_bedrock
    if token and token.get_secret_value().strip():
        os.environ.setdefault("AWS_BEARER_TOKEN_BEDROCK", token.get_secret_value().strip())


def create_app() -> FastAPI:
    settings = get_settings()
    _export_bedrock_token(settings)
    app = FastAPI(title="Shelfie", version=__version__, lifespan=lifespan)

    app.add_middleware(CsrfMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)

    # In production the built frontend is served from static_dir. In dev it may not
    # exist yet (Vite serves it on :5173), so mount only when present.
    static_path = settings.static_path
    if static_path.is_dir():
        app.mount("/", SpaStaticFiles(directory=str(static_path), html=True), name="static")

    return app


app = create_app()
