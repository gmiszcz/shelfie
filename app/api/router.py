"""Aggregate all API routers under /api."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import (
    admin,
    agui,
    auth,
    books,
    covers,
    health,
    preferences,
    ratings,
    search,
    series,
    stats,
    transcribe,
    warmup,
)

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(admin.router)
api_router.include_router(books.router)
api_router.include_router(covers.router)
api_router.include_router(search.router)
api_router.include_router(stats.router)
api_router.include_router(ratings.router)
api_router.include_router(series.router)
api_router.include_router(preferences.router)
api_router.include_router(agui.router)
api_router.include_router(transcribe.router)
api_router.include_router(warmup.router)
