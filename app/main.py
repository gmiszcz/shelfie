"""FastAPI application: lifespan, CORS, routing, static frontend mount."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.middleware import CsrfMiddleware
from app.api.router import api_router
from app.authdb import init_auth_db
from app.config import get_settings
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


def create_app() -> FastAPI:
    settings = get_settings()
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
        app.mount("/", StaticFiles(directory=str(static_path), html=True), name="static")

    return app


app = create_app()
