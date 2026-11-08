"""Google Books API client.

Thin async wrapper over httpx. Normalizes the sparse volume JSON into our ``VolumeSearchResult``
schema — every ``volumeInfo`` field is optional and ISBNs live in ``industryIdentifiers[]``, so we
null-guard everywhere. Cover URLs are rewritten to the highest available resolution over HTTPS with
the page-curl artifact removed (see docs/research-google-books-api.md).

Quota protection (wave 5)
-------------------------
Google Books has a hard daily quota and the user asked that it never be hammered:

- **Persistent on-disk cache**: every successful GET is cached as JSON under
  ``data/cache/google_books/`` keyed by the normalised query params (the API key is
  excluded from the key), with a default 30-day TTL. A cache hit does NOT count against
  the quota and makes no network call. The series checker and scripts therefore read the
  cache first automatically.
- **Per-process call budget**: at most ``GOOGLE_BOOKS_MAX_CALLS`` (default 50) live calls
  per process; past that the client refuses with :class:`GoogleBooksBudgetExceeded`.
- **Stop on 429**: the first ``429`` ('Queries per day') is surfaced immediately with no
  retries, and the caller (series lookup) falls back to OpenLibrary.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from app.schemas.books import VolumeSearchResult

logger = logging.getLogger(__name__)

# Per-process counter of live Google Books calls, shared across client instances so a
# fan-out of lookups in one process cannot blow past the budget.
_CALL_COUNT = 0


def _reset_call_count() -> None:
    """Test helper: reset the process-wide live-call counter."""
    global _CALL_COUNT
    _CALL_COUNT = 0


def live_call_count() -> int:
    return _CALL_COUNT


class GoogleBooksBudgetExceeded(RuntimeError):
    """The per-process Google Books call budget was reached."""


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
        *,
        cache_dir: str | Path | None = None,
        cache_ttl_days: int | None = None,
        max_calls: int | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client
        # Cache + budget settings. Fall back to the app config when not given, so a
        # bare GoogleBooksClient(base_url=...) still gets the on-disk cache and budget.
        if cache_dir is None or cache_ttl_days is None or max_calls is None:
            try:
                from app.config import get_settings

                settings = get_settings()
                cache_dir = cache_dir if cache_dir is not None else settings.google_books_cache_path
                cache_ttl_days = (
                    cache_ttl_days
                    if cache_ttl_days is not None
                    else settings.google_books_cache_ttl_days
                )
                max_calls = max_calls if max_calls is not None else settings.google_books_max_calls
            except Exception:  # noqa: BLE001 - tests may construct without a config
                cache_dir = cache_dir
                cache_ttl_days = 30 if cache_ttl_days is None else cache_ttl_days
                max_calls = 50 if max_calls is None else max_calls
        self._cache_dir = Path(cache_dir) if cache_dir else None
        self._cache_ttl_seconds = int((cache_ttl_days or 0) * 86400)
        self._max_calls = int(max_calls if max_calls is not None else 50)

    def _cache_key(self, path: str, params: dict[str, Any]) -> str:
        """Stable hash of path + params WITHOUT the API key (so the key never leaks)."""
        safe = {k: v for k, v in params.items() if k != "key"}
        payload = json.dumps([path, sorted(safe.items())], ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _cache_read(self, key: str) -> dict[str, Any] | None:
        if not self._cache_dir:
            return None
        file = self._cache_dir / f"{key}.json"
        if not file.is_file():
            return None
        try:
            entry = json.loads(file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        stored = entry.get("stored_at", 0)
        # TTL 0 disables cache reads (every entry treated as expired); otherwise honour it.
        if self._cache_ttl_seconds == 0:
            return None
        if time.time() - stored > self._cache_ttl_seconds:
            return None  # expired
        data = entry.get("data")
        return data if isinstance(data, dict) else None

    def _cache_write(self, key: str, data: dict[str, Any]) -> None:
        if not self._cache_dir:
            return
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            (self._cache_dir / f"{key}.json").write_text(
                json.dumps({"stored_at": time.time(), "data": data}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            logger.warning("could not write Google Books cache entry %s", key)

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        # 1) Cache first — a hit makes no network call and never touches the quota.
        key = self._cache_key(path, params)
        cached = self._cache_read(key)
        if cached is not None:
            logger.debug("Google Books cache hit for %s", key)
            return cached

        # 2) Per-process budget — refuse rather than hammer the quota.
        global _CALL_COUNT
        if _CALL_COUNT >= self._max_calls:
            raise GoogleBooksBudgetExceeded(
                f"Google Books per-process call budget reached ({self._max_calls}); "
                "refusing to call the API. Raise GOOGLE_BOOKS_MAX_CALLS or rely on the cache."
            )

        request_params = dict(params)
        if self._api_key:
            request_params["key"] = self._api_key

        _CALL_COUNT += 1
        if self._client is not None:
            resp = await self._client.get(f"{self._base_url}{path}", params=request_params)
        else:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self._base_url}{path}", params=request_params)
        # 3) Stop on 429 with no retries; let the caller fall back to OpenLibrary.
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        self._cache_write(key, data)
        return data

    async def search(
        self, query: str, max_results: int = 20, lang: str | None = None
    ) -> tuple[int, list[VolumeSearchResult]]:
        """Search volumes. ``max_results`` is capped at 40 by the API.

        ``lang`` is an ISO-639-1 code (e.g. ``en``, ``pl``) that restricts results by language.
        A cached response is served without a network call. On a 429 (quota) without an API
        key we fall back to OpenLibrary; with a key the 429 propagates so the series lookup
        can record the quota state and fall back itself (no retries).
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
