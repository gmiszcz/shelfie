"""Find and store real cover images for books that have none (Wave 4, Task A).

For every book in ``data/books.json`` with an empty ``cover_url`` this script looks for a real
cover image, trying several sources in order, verifies the candidate is a genuine image, stores
it in the app's cover storage (``data/covers/``) and writes the resulting ``/api/covers/<name>``
URL back to BOTH the JSON dataset and the live SQLite database (a targeted ``UPDATE`` by book id;
the ``comparisons`` table is never touched).

Sources, in order, per book:

1. Google Books by ISBN-13 then ISBN-10 (``GOOGLE_BOOKS_API_KEY`` from ``.env`` when present).
2. The record's own Google volume id (``books.google.com/books/content?id=...``) -- a
   correct-by-construction cover when Google holds one for that exact volume.
3. Google Books by title + author, restricted to the book's language.
4. OpenLibrary covers by ISBN-13 then ISBN-10 (``?default=false``).
5. OpenLibrary search by title + author.

A candidate URL is accepted only when it returns HTTP 200, an image content type (sniffed from
the bytes, with the declared ``image/*`` type as a fallback), and a body larger than
:data:`MIN_IMAGE_BYTES`. That floor rejects Google's ~1.3 KB "no cover available" placeholder,
so a placeholder is never stored. Requests are rate-limited and back off on HTTP 429.

Every source is keyed to the specific book (its ISBN, its Google volume id, or its title+author
restricted to its language); the script never trusts the top hit of a free-text catalogue search
that could belong to a different edition or book.

    python -m scripts.fill_covers                 # fix every book missing a cover
    python -m scripts.fill_covers --limit 5       # only the first 5 that need it
    python -m scripts.fill_covers --dry-run       # report what would change, write nothing
    python -m scripts.fill_covers --no-download    # store the verified URL instead of a local file

The JSON file is written after every book, so an interruption keeps all progress so far.
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import _dataio  # noqa: E402

# A real book cover is comfortably larger than this; a placeholder/blank is smaller.
MIN_IMAGE_BYTES = 2 * 1024
# Polite spacing between outbound requests, and the base backoff when a host returns 429.
REQUEST_SPACING_S = 0.34
BACKOFF_BASE_S = 2.0
MAX_RETRIES = 4

GOOGLE_BASE = "https://www.googleapis.com/books/v1/volumes"
GOOGLE_CONTENT = (
    "https://books.google.com/books/content?id={vid}"
    "&printsec=frontcover&img=1&zoom=1&source=gbs_api&fife=w800"
)
OPENLIBRARY_SEARCH = "https://openlibrary.org/search.json"
OPENLIBRARY_ISBN_COVER = "https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg?default=false"
OPENLIBRARY_ID_COVER = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg?default=false"

_COVER_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


def read_env_api_key(root: Path) -> str | None:
    """Read GOOGLE_BOOKS_API_KEY from the repo .env without importing pydantic settings."""
    env = root / ".env"
    if not env.is_file():
        return None
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("GOOGLE_BOOKS_API_KEY="):
            value = line.split("=", 1)[1].strip()
            return value or None
    return None


def _sniff_image(data: bytes) -> str | None:
    """Content type from magic bytes. Mirrors app.services.books._sniff_image, plus GIF."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


@dataclass
class CoverResult:
    """What was found for one book."""

    url: str | None = None  # verified source URL
    image: bytes | None = None  # downloaded bytes, when available
    content_type: str | None = None
    source: str | None = None  # which lookup produced it


@dataclass
class Report:
    fixed: int = 0
    still_missing: list[tuple[str, str]] = field(default_factory=list)  # (title, reason)
    sources: dict[str, int] = field(default_factory=dict)


class CoverFinder:
    """Resolves a cover for a book, verifying every candidate is a real image.

    The HTTP client is injected so tests can run without a network. ``sleep`` is injected too
    so the rate-limiting delay is free in tests.
    """

    def __init__(
        self,
        client: httpx.Client,
        api_key: str | None,
        *,
        sleep: Callable[[float], None] = time.sleep,
        spacing_s: float = REQUEST_SPACING_S,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._sleep = sleep
        self._spacing = spacing_s
        self._last_request = 0.0

    # -- low-level request with spacing + 429 backoff ----------------------------------------

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response | None:
        for attempt in range(MAX_RETRIES):
            gap = self._spacing - (time.monotonic() - self._last_request)
            if gap > 0:
                self._sleep(gap)
            try:
                resp = self._client.request(method, url, **kwargs)
            except httpx.HTTPError:
                self._last_request = time.monotonic()
                return None
            self._last_request = time.monotonic()
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                delay = (
                    float(retry_after)
                    if (retry_after or "").isdigit()
                    else BACKOFF_BASE_S * (2**attempt)
                )
                self._sleep(delay)
                continue
            return resp
        return None

    # -- candidate verification --------------------------------------------------------------

    def verify_image(self, url: str) -> tuple[bytes, str] | None:
        """Fetch ``url`` and return ``(bytes, content_type)`` only if it is a real image."""
        resp = self._request("GET", url, follow_redirects=True)
        if resp is None or resp.status_code != 200:
            return None
        declared = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        data = resp.content
        if len(data) < MIN_IMAGE_BYTES:
            return None
        sniffed = _sniff_image(data)
        # Accept when the bytes sniff as an image; fall back to the declared image/* type.
        content_type = sniffed or (declared if declared.startswith("image/") else None)
        if content_type is None:
            return None
        return data, content_type

    # -- individual sources ------------------------------------------------------------------

    def _google_cover_from_items(self, items: list[dict[str, Any]]) -> str | None:
        for item in items:
            links = item.get("volumeInfo", {}).get("imageLinks", {})
            for key in ("extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"):
                if key in links:
                    url = links[key].replace("http://", "https://")
                    url = (
                        url.replace("&edge=curl", "")
                        .replace("edge=curl&", "")
                        .replace("edge=curl", "")
                    )
                    if "zoom=" in url and "fife=" not in url:
                        url = url + "&fife=w800"
                    return url
        return None

    def _google_query(self, query: str, lang: str | None) -> str | None:
        params: dict[str, Any] = {"q": query, "maxResults": 5, "country": "US"}
        if lang:
            params["langRestrict"] = lang
        if self._api_key:
            params["key"] = self._api_key
        resp = self._request("GET", GOOGLE_BASE, params=params)
        if resp is None or resp.status_code != 200:
            return None
        try:
            items = resp.json().get("items", [])
        except ValueError:
            return None
        return self._google_cover_from_items(items)

    def google_by_isbn(self, isbn: str) -> str | None:
        return self._google_query(f"isbn:{isbn}", None)

    def google_by_title_author(
        self, title: str, author: str | None, lang: str | None
    ) -> str | None:
        query = f'intitle:"{title}"'
        if author:
            query += f' inauthor:"{author}"'
        return self._google_query(query, lang)

    def openlibrary_by_isbn(self, isbn: str) -> str | None:
        return OPENLIBRARY_ISBN_COVER.format(isbn=quote(isbn))

    def openlibrary_by_title_author(self, title: str, author: str | None) -> str | None:
        params: dict[str, Any] = {
            "title": title,
            "fields": "cover_i",
            "limit": 3,
        }
        if author:
            params["author"] = author
        resp = self._request("GET", OPENLIBRARY_SEARCH, params=params)
        if resp is None or resp.status_code != 200:
            return None
        try:
            docs = resp.json().get("docs", [])
        except ValueError:
            return None
        for doc in docs:
            cover_id = doc.get("cover_i")
            if cover_id:
                return OPENLIBRARY_ID_COVER.format(cover_id=cover_id)
        return None

    def google_content_by_volume_id(self, volume_id: str) -> str | None:
        """The book's own Google cover-content URL. Verification rejects the 'no cover' placeholder."""
        return GOOGLE_CONTENT.format(vid=quote(volume_id))

    # -- orchestration -----------------------------------------------------------------------

    def find(self, record: dict[str, Any]) -> CoverResult:
        """Try every source in order; return the first candidate that verifies as an image."""
        title = (record.get("title") or "").strip()
        authors = record.get("authors") or []
        author = authors[0] if authors else None
        lang = record.get("language")
        isbn13 = (record.get("isbn_13") or "").strip()
        isbn10 = (record.get("isbn_10") or "").strip()
        volume_id = (record.get("google_volume_id") or "").strip()

        attempts: list[tuple[str, Callable[[], str | None]]] = []
        if isbn13:
            attempts.append(("google_isbn13", lambda: self.google_by_isbn(isbn13)))
        if isbn10:
            attempts.append(("google_isbn10", lambda: self.google_by_isbn(isbn10)))
        # The record's own Google volume id: a correct-by-construction cover when Google has one.
        if volume_id:
            attempts.append(
                ("google_volume_id", lambda: self.google_content_by_volume_id(volume_id))
            )
        if title:
            attempts.append(
                ("google_title_author", lambda: self.google_by_title_author(title, author, lang))
            )
        if isbn13:
            attempts.append(("openlibrary_isbn13", lambda: self.openlibrary_by_isbn(isbn13)))
        if isbn10:
            attempts.append(("openlibrary_isbn10", lambda: self.openlibrary_by_isbn(isbn10)))
        if title:
            attempts.append(
                (
                    "openlibrary_title_author",
                    lambda: self.openlibrary_by_title_author(title, author),
                )
            )

        for source, produce in attempts:
            url = produce()
            if not url:
                continue
            verified = self.verify_image(url)
            if verified is None:
                continue
            data, content_type = verified
            return CoverResult(url=url, image=data, content_type=content_type, source=source)
        return CoverResult()


def store_cover(covers_dir: Path, data: bytes, content_type: str) -> str:
    """Write the image into the app's cover storage and return the ``/api/covers/<name>`` URL."""
    ext = _COVER_EXT.get(content_type, ".jpg")
    covers_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (covers_dir / name).write_bytes(data)
    return f"/api/covers/{name}"


def run(
    root: Path,
    *,
    dry_run: bool,
    limit: int | None,
    download: bool,
    finder_factory: Callable[[httpx.Client, str | None], CoverFinder] | None = None,
) -> int:
    data_dir = root / "data"
    dataset_file = data_dir / "books.json"
    db_file = data_dir / "shelfie.sqlite"
    covers_dir = data_dir / "covers"

    payload = _dataio.load_dataset(dataset_file)
    books: list[dict[str, Any]] = payload["books"]
    missing = [b for b in books if not (b.get("cover_url") or "").strip()]
    print(f"{len(missing)} of {len(books)} books have no cover.")

    if not dry_run:
        backup = _dataio.backup_data(data_dir, db_file, dataset_file)
        print(f"Backup: {backup}")

    conn = _dataio.connect_db(db_file)
    comparisons_before = _dataio.count_comparisons(conn)
    index = _dataio.load_db_index(conn)

    api_key = read_env_api_key(root)
    report = Report()
    factory = finder_factory or (lambda client, key: CoverFinder(client, key))

    try:
        with httpx.Client(
            timeout=20.0,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
                )
            },
        ) as client:
            finder = factory(client, api_key)
            processed = 0
            for record in missing:
                if limit is not None and processed >= limit:
                    break
                processed += 1
                title = record.get("title") or "?"
                db_id = _dataio.match_db_id(record, index)
                result = finder.find(record)
                if result.url is None:
                    report.still_missing.append((title, "no verified cover from any source"))
                    print(f"  MISS  {title!r}: no cover found")
                    continue

                if download and result.image is not None:
                    cover_url = (
                        result.url
                        if dry_run
                        else store_cover(
                            covers_dir, result.image, result.content_type or "image/jpeg"
                        )
                    )
                else:
                    cover_url = result.url

                report.sources[result.source or "?"] = (
                    report.sources.get(result.source or "?", 0) + 1
                )

                if dry_run:
                    report.fixed += 1
                    where = "download" if (download and result.image) else "url"
                    print(f"  OK    {title!r}: {result.source} ({where}) <- {result.url}")
                    continue

                record["cover_url"] = cover_url
                _dataio.atomic_write_json(dataset_file, payload)
                if db_id is not None:
                    conn.execute(
                        "UPDATE books SET cover_url = ?, updated_at = datetime('now') "
                        "WHERE user_id = ? AND id = ?",
                        (cover_url, _dataio.SINGLE_USER_ID, db_id),
                    )
                    conn.commit()
                    report.fixed += 1
                    print(f"  OK    {title!r}: {result.source} -> {cover_url} (db id {db_id})")
                else:
                    report.still_missing.append((title, "found cover but no matching DB row"))
                    print(f"  WARN  {title!r}: cover found but no DB match; JSON updated only")
    finally:
        comparisons_after = _dataio.count_comparisons(conn)
        conn.close()

    print("\n=== Task A summary ===")
    print(f"Fixed: {report.fixed}")
    print(f"Still missing: {len(report.still_missing)}")
    for title, reason in report.still_missing:
        print(f"  - {title!r}: {reason}")
    print(f"By source: {report.sources}")
    print(f"Comparisons before={comparisons_before} after={comparisons_after}")
    if comparisons_before != comparisons_after:
        print("ERROR: comparison count changed!", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--limit", type=int, default=None, help="only process this many books")
    parser.add_argument(
        "--no-download",
        dest="download",
        action="store_false",
        help="store the verified remote URL instead of downloading into data/covers",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="repository root whose data/ to edit (default: this script's repo). "
        "Point it at the live checkout when running from a worktree.",
    )
    parser.set_defaults(download=True)
    args = parser.parse_args()
    root = args.root or Path(__file__).resolve().parents[1]
    sys.exit(run(root, dry_run=args.dry_run, limit=args.limit, download=args.download))


if __name__ == "__main__":
    main()
