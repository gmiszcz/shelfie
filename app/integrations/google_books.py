"""Google Books API client.

Thin async wrapper over httpx. Normalizes the sparse volume JSON into our ``VolumeSearchResult``
schema — every ``volumeInfo`` field is optional and ISBNs live in ``industryIdentifiers[]``, so we
null-guard everywhere. Cover URLs are rewritten to the highest available resolution over HTTPS with
the page-curl artifact removed (see docs/research-google-books-api.md).
"""

from __future__ import annotations

from typing import Any

import httpx

from app.schemas.books import VolumeSearchResult


def _best_cover(image_links: dict[str, str]) -> str | None:
    """Pick the largest available cover and upgrade it to a high-res HTTPS URL."""
    if not image_links:
        return None
    # Prefer the largest documented key present; fall back to thumbnail.
    for key in ("extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"):
        if key in image_links:
            url = image_links[key]
            break
    else:
        return None
    url = url.replace("http://", "https://")
    url = url.replace("&edge=curl", "").replace("edge=curl&", "").replace("edge=curl", "")
    # Request a larger render; the server returns the largest it has up to this size.
    if "zoom=" in url and "fife=" not in url:
        url = url + "&fife=w800"
    return url


def _extract_isbns(identifiers: list[dict[str, str]]) -> tuple[str | None, str | None]:
    isbn_10: str | None = None
    isbn_13: str | None = None
    for entry in identifiers:
        kind = entry.get("type")
        value = entry.get("identifier")
        if kind == "ISBN_10":
            isbn_10 = value
        elif kind == "ISBN_13":
            isbn_13 = value
    return isbn_10, isbn_13


def normalize_volume(item: dict[str, Any]) -> VolumeSearchResult:
    info: dict[str, Any] = item.get("volumeInfo", {})
    isbn_10, isbn_13 = _extract_isbns(info.get("industryIdentifiers", []))
    return VolumeSearchResult(
        google_volume_id=item.get("id"),
        title=info.get("title", "Untitled"),
        subtitle=info.get("subtitle"),
        authors=list(info.get("authors", [])),
        publisher=info.get("publisher"),
        published_date=info.get("publishedDate"),
        description=info.get("description"),
        page_count=info.get("pageCount"),
        categories=list(info.get("categories", [])),
        language=info.get("language"),
        isbn_10=isbn_10,
        isbn_13=isbn_13,
        cover_url=_best_cover(info.get("imageLinks", {})),
    )


class GoogleBooksClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._api_key:
            params = {**params, "key": self._api_key}
        if self._client is not None:
            resp = await self._client.get(f"{self._base_url}{path}", params=params)
        else:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self._base_url}{path}", params=params)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data

    async def search(
        self, query: str, max_results: int = 20, lang: str | None = None
    ) -> tuple[int, list[VolumeSearchResult]]:
        """Search volumes. ``max_results`` is capped at 40 by the API.

        ``lang`` is an ISO-639-1 code (e.g. ``en``, ``pl``) that restricts results by language.
        Without an API key the keyless Google endpoint is aggressively rate-limited; on a 429
        we fall back to OpenLibrary (keyless, not quota-gated) so search still works out of the box.
        """
        params: dict[str, Any] = {"q": query, "maxResults": min(max_results, 40)}
        if lang:
            params["langRestrict"] = lang
        try:
            data = await self._get("/volumes", params)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429 and not self._api_key:
                from app.integrations.openlibrary import OpenLibraryClient

                return await OpenLibraryClient(self._client).search(query, max_results, lang)
            raise
        items = [normalize_volume(item) for item in data.get("items", [])]
        total = int(data.get("totalItems", 0))
        # If Google found nothing, try OpenLibrary as a second source.
        if not items:
            from app.integrations.openlibrary import OpenLibraryClient

            return await OpenLibraryClient(self._client).search(query, max_results, lang)
        return total, items
