"""Google Books search endpoint.

When Google Books cannot be used (its daily quota answered ``429``, or the per-process
call budget is spent) the search falls back to OpenLibrary and says so in ``notice``.
If OpenLibrary has nothing either, the endpoint answers ``429`` with a plain message
telling the user to try again tomorrow. It never returns a silent "no matches".
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import BooksClient, CurrentUser
from app.integrations.google_books import GoogleBooksBudgetExceeded
from app.integrations.openlibrary import OpenLibraryClient
from app.schemas.books import SearchResponse
from app.services import books as service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/search", tags=["search"])

QUOTA = "Google Books daily limit reached"
BUDGET = "Google Books is paused on this server (call limit GOOGLE_BOOKS_MAX_CALLS reached)"


def _notice(reason: str) -> str:
    return f"{reason}. Showing OpenLibrary results instead. Try Google again tomorrow."


def _empty(reason: str) -> str:
    return f"{reason} and OpenLibrary found nothing. Try again tomorrow, or add the book manually."


async def _openlibrary_fallback(q: str, lang: str | None, reason: str) -> SearchResponse:
    try:
        total, items = await OpenLibraryClient(None).search(q, 20, lang)
    except httpx.HTTPError:
        logger.warning("OpenLibrary fallback failed for %r", q)
        total, items = 0, []
    if not items:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=_empty(reason))
    return SearchResponse(total_items=total, items=items, notice=_notice(reason))


@router.get("", response_model=SearchResponse)
async def search_books(
    client: BooksClient,
    _user: CurrentUser,
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
    except GoogleBooksBudgetExceeded:
        logger.info("Google Books call budget spent; falling back to OpenLibrary")
        return await _openlibrary_fallback(q, lang, BUDGET)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            logger.info("Google Books quota (429); falling back to OpenLibrary")
            return await _openlibrary_fallback(q, lang, QUOTA)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Google Books request failed",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Google Books request failed",
        ) from exc
