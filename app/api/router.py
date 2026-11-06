"""Aggregate all API routers under /api."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import agent, books, covers, health, ratings, search, stats, transcribe

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(books.router)
api_router.include_router(covers.router)
api_router.include_router(search.router)
api_router.include_router(stats.router)
api_router.include_router(ratings.router)
api_router.include_router(agent.router)
api_router.include_router(transcribe.router)
