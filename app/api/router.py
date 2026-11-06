"""Aggregate all API routers under /api."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import books, health, search

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(books.router)
api_router.include_router(search.router)
