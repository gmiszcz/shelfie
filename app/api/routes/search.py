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
    lang: str | None = Query(
        default=None,
        min_length=2,
        max_length=2,
        description="Optional ISO-639-1 language filter, e.g. 'pl' or 'en'",
    ),
) -> SearchResponse:
    try:
        return await service.search_external(client, q, lang)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    "Google Books rate limit reached. Set GOOGLE_BOOKS_API_KEY in .env "
                    "to raise the quota."
                ),
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Google Books request failed",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Google Books request failed",
        ) from exc
