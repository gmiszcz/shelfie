"""OpenLibrary search client — a keyless fallback for Google Books.

OpenLibrary (https://openlibrary.org/dev/docs/api/search) needs no API key and is not quota-gated
the way the keyless Google Books endpoint is, so it is used as a fallback when Google returns 429.
Responses are normalized into the same ``VolumeSearchResult`` schema the rest of the app uses.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.schemas.books import VolumeSearchResult

SEARCH_URL = "https://openlibrary.org/search.json"
COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"

# Fields we need, to keep the response small.
_FIELDS = "key,title,subtitle,author_name,first_publish_year,isbn,cover_i,language,subject"


def _normalize_doc(doc: dict[str, Any]) -> VolumeSearchResult:
    isbns: list[str] = doc.get("isbn", []) or []
    isbn_13 = next((i for i in isbns if len(i) == 13), None)
    isbn_10 = next((i for i in isbns if len(i) == 10), None)
    cover_id = doc.get("cover_i")
    languages = doc.get("language", []) or []
    return VolumeSearchResult(
        # Reuse the Google volume-id slot for OpenLibrary's work key so dedup still works.
        google_volume_id=doc.get("key"),
        title=doc.get("title", "Untitled"),
        subtitle=doc.get("subtitle"),
        authors=list(doc.get("author_name", []) or []),
        publisher=None,
        published_date=str(doc["first_publish_year"]) if doc.get("first_publish_year") else None,
        description=None,
        page_count=None,
        categories=list((doc.get("subject", []) or [])[:5]),
        language=languages[0] if languages else None,
        isbn_10=isbn_10,
        isbn_13=isbn_13,
        cover_url=COVER_URL.format(cover_id=cover_id) if cover_id else None,
    )


# Map ISO-639-1 (what the API/UI uses) to OpenLibrary's 3-letter language codes.
_LANG_MAP = {"en": "eng", "pl": "pol", "de": "ger", "fr": "fre", "es": "spa", "ru": "rus"}


class OpenLibraryClient:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def search(
        self, query: str, max_results: int = 20, lang: str | None = None
    ) -> tuple[int, list[VolumeSearchResult]]:
        params: dict[str, str | int] = {
            "q": query,
            "limit": min(max_results, 40),
            "fields": _FIELDS,
        }
        if lang:
            params["language"] = _LANG_MAP.get(lang, lang)
        if self._client is not None:
            resp = await self._client.get(SEARCH_URL, params=params)
        else:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(SEARCH_URL, params=params)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        docs = data.get("docs", [])
        items = [_normalize_doc(doc) for doc in docs]
        return int(data.get("numFound", len(items))), items
