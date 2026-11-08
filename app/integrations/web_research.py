"""Web research helpers for the release-research step (wave 5).

Two primitives the series-research agent uses to find a next volume on the open web —
deliberately independent of Google Books (which has a hard daily quota and is never
called here):

* :func:`web_search` — a DuckDuckGo HTML search (``https://html.duckduckgo.com/html/``),
  parsed into at most 8 ``{title, url, snippet}`` results. No API key, no JS.
* :func:`fetch_url` — fetch one page and return its readable text, capped at ~6000 chars.

Both are disk-cached under ``data/cache/web/`` with a 7-day TTL (a cache hit makes no
network call), and both go through a :class:`CallBudget` that caps how many LIVE calls a
single research run may make (default 12). A browser ``User-Agent`` is sent so the HTML
endpoints answer. Everything is defensive: a network or parse error returns an empty
result rather than raising, so one bad page never aborts a research run.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

DDG_HTML_URL = "https://html.duckduckgo.com/html/"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)
MAX_RESULTS = 8
FETCH_CHAR_CAP = 6000


class CallBudget:
    """A per-research-run cap on live (uncached) web calls.

    Cache hits do not consume budget; only a real HTTP request does. Once the budget is
    spent, further live calls are refused (the helper returns empty) so a single run can
    never make an unbounded number of requests.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0

    def take(self) -> bool:
        if self.used >= self.limit:
            return False
        self.used += 1
        return True


def _cache_dir() -> Path:
    return get_settings().web_cache_path


def _ttl_seconds() -> int:
    return get_settings().web_cache_ttl_days * 24 * 3600


def _cache_path(kind: str, key: str) -> Path:
    digest = hashlib.sha256(f"{kind}:{key}".encode()).hexdigest()[:40]
    return _cache_dir() / f"{kind}-{digest}.json"


def _read_cache(kind: str, key: str) -> Any | None:
    path = _cache_path(kind, key)
    if not path.is_file():
        return None
    ttl = _ttl_seconds()
    if ttl and (time.time() - path.stat().st_mtime) > ttl:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _write_cache(kind: str, key: str, payload: Any) -> None:
    path = _cache_path(kind, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        logger.warning("web cache write failed for %s/%s: %s", kind, key, exc)


# --- DuckDuckGo HTML result parsing ------------------------------------------------------

_RESULT_BLOCK = re.compile(
    r'<a[^>]*class="result__a"[^>]*href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>'
    r'(?P<rest>.*?)(?=<a[^>]*class="result__a"|</div>\s*</div>\s*</div>|$)',
    re.IGNORECASE | re.DOTALL,
)
_SNIPPET = re.compile(r'class="result__snippet"[^>]*>(?P<snip>.*?)</a>', re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    return html.unescape(_TAGS.sub("", text)).strip()


def _real_url(href: str) -> str:
    """DuckDuckGo wraps hits in a redirect (``/l/?uddg=<encoded>``). Unwrap it."""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        qs = parse_qs(parsed.query)
        target = qs.get("uddg", [None])[0]
        if target:
            return unquote(target)
    return href


def parse_ddg_html(body: str) -> list[dict[str, str]]:
    """Parse DuckDuckGo HTML search output into ``{title, url, snippet}`` (max 8)."""
    results: list[dict[str, str]] = []
    for match in _RESULT_BLOCK.finditer(body):
        title = _clean(match.group("title"))
        url = _real_url(match.group("url"))
        snip_match = _SNIPPET.search(match.group("rest") or "")
        snippet = _clean(snip_match.group("snip")) if snip_match else ""
        if title and url:
            results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= MAX_RESULTS:
            break
    return results


# --- public helpers ----------------------------------------------------------------------


def web_search(query: str, *, budget: CallBudget | None = None) -> list[dict[str, str]]:
    """Search the web via DuckDuckGo HTML. Returns up to 8 ``{title, url, snippet}``.

    Disk-cached (7-day TTL). A cache hit makes no network call and does not consume the
    run's budget. Returns ``[]`` on error or when the budget is spent.
    """
    query = (query or "").strip()
    if not query:
        return []
    cached = _read_cache("search", query)
    if cached is not None:
        return cached

    if budget is not None and not budget.take():
        logger.info("web_search budget spent; skipping live call for %r", query)
        return []
    try:
        resp = httpx.post(
            DDG_HTML_URL,
            data={"q": query},
            headers={"User-Agent": _UA, "Accept-Language": "pl,en;q=0.8"},
            timeout=15.0,
            follow_redirects=True,
        )
        resp.raise_for_status()
        results = parse_ddg_html(resp.text)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("web_search failed for %r: %s", query, exc)
        return []
    _write_cache("search", query, results)
    return results


def fetch_url(url: str, *, budget: CallBudget | None = None) -> str:
    """Fetch one URL and return its readable text, capped at ~6000 chars.

    Disk-cached (7-day TTL). A cache hit makes no network call. Returns ``""`` on error or
    when the budget is spent.
    """
    url = (url or "").strip()
    if not url or not url.lower().startswith(("http://", "https://")):
        return ""
    cached = _read_cache("fetch", url)
    if cached is not None:
        return cached

    if budget is not None and not budget.take():
        logger.info("fetch_url budget spent; skipping live call for %r", url)
        return ""
    try:
        resp = httpx.get(
            url,
            headers={"User-Agent": _UA, "Accept-Language": "pl,en;q=0.8"},
            timeout=15.0,
            follow_redirects=True,
        )
        resp.raise_for_status()
        text = readable_text(resp.text)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("fetch_url failed for %r: %s", url, exc)
        return ""
    _write_cache("fetch", url, text)
    return text


_SCRIPT_STYLE = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_WS = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def readable_text(body: str, *, cap: int = FETCH_CHAR_CAP) -> str:
    """Strip HTML to readable text, collapse whitespace, cap at ``cap`` chars."""
    body = _SCRIPT_STYLE.sub(" ", body)
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.IGNORECASE)
    body = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", body, flags=re.IGNORECASE)
    text = html.unescape(_TAGS.sub(" ", body))
    text = _WS.sub(" ", text)
    text = _BLANK_LINES.sub("\n\n", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = text.strip()
    return text[:cap]
