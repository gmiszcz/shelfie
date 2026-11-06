"""Google Books search endpoint."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import BooksClient
from app.schemas.books import SearchResponse
from app.services import books as service

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=SearchResponse)
async def search_books(
    client: BooksClient,
    q: str = Query(
        min_length=1, description="Free text or qualifiers (isbn:, intitle:, inauthor:)"
    ),
) -> SearchResponse:
    try:
        return await service.search_external(client, q)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Google Books request failed",
        ) from exc
