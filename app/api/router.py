"""Aggregate all API routers under /api."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import (
    admin,
    agent,
    agui,
    auth,
    books,
    covers,
    health,
    ratings,
    search,
    series,
    stats,
    transcribe,
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
api_router.include_router(agent.router)
api_router.include_router(agui.router)
api_router.include_router(transcribe.router)
