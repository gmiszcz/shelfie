"""Seed the Shelfie database with realistic books.

`just sample` runs this. It:
  1. Reads titles from a CSV in data/ (any file matching data/*.csv) if present, taking the
     first column that looks like a title (optionally a second 'author' column); otherwise
     falls back to a built-in list of popular fantasy / sci-fi / tech books.
  2. Queries Google Books for each, normalizes the first hit, and inserts it into the library.
  3. Skips books already present (same Google volume id).

CSV format: a header row is auto-detected. Recognized title columns: title, Title, "Book Title".
Recognized author columns: author, authors, Author. If no header matches, the first column is
treated as the title and the second (if any) as the author — matching a typical Bookshelf export.

Run: `just sample`  (or `uv run python -m scripts.seed`)
"""

from __future__ import annotations

import asyncio
import csv
import os
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.db import SINGLE_USER_ID, connect, init_db  # noqa: E402
from app.integrations.google_books import GoogleBooksClient  # noqa: E402
from app.repositories import books as repo  # noqa: E402
from app.schemas.books import BookCreate, ReadingStatus  # noqa: E402

FALLBACK_TITLES: list[tuple[str, str]] = [
    ("The Name of the Wind", "Patrick Rothfuss"),
    ("Mistborn: The Final Empire", "Brandon Sanderson"),
    ("The Way of Kings", "Brandon Sanderson"),
    ("A Game of Thrones", "George R. R. Martin"),
    ("The Lies of Locke Lamora", "Scott Lynch"),
    ("Dune", "Frank Herbert"),
    ("Project Hail Mary", "Andy Weir"),
    ("The Three-Body Problem", "Liu Cixin"),
    ("Neuromancer", "William Gibson"),
    ("Snow Crash", "Neal Stephenson"),
    ("Hyperion", "Dan Simmons"),
    ("The Left Hand of Darkness", "Ursula K. Le Guin"),
    ("The Pragmatic Programmer", "Andrew Hunt"),
    ("Clean Code", "Robert C. Martin"),
    ("Designing Data-Intensive Applications", "Martin Kleppmann"),
    ("The Phoenix Project", "Gene Kim"),
    ("Structure and Interpretation of Computer Programs", "Harold Abelson"),
    ("Code: The Hidden Language of Computer Hardware and Software", "Charles Petzold"),
]

TITLE_KEYS = {"title", "book title", "name"}
AUTHOR_KEYS = {"author", "authors"}


def read_csv_titles(data_dir: Path) -> list[tuple[str, str]]:
    """Return (title, author) pairs from the first CSV found in data/, or []."""
    csv_files = sorted(data_dir.glob("*.csv"))
    if not csv_files:
        return []
    path = csv_files[0]
    print(f"Reading titles from {path}")
    rows: list[tuple[str, str]] = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        sample = fh.read(2048)
        fh.seek(0)
        has_header = csv.Sniffer().has_header(sample) if sample.strip() else False
        reader = csv.reader(fh)
        header: list[str] = next(reader, []) if has_header else []
        title_idx, author_idx = 0, 1
        if header:
            lower = [h.strip().lower() for h in header]
            title_idx = next((i for i, h in enumerate(lower) if h in TITLE_KEYS), 0)
            author_idx = next((i for i, h in enumerate(lower) if h in AUTHOR_KEYS), -1)
        for row in reader:
            if not row or not row[title_idx].strip():
                continue
            title = row[title_idx].strip()
            author = row[author_idx].strip() if 0 <= author_idx < len(row) else ""
            rows.append((title, author))
    return rows


def clean_title(title: str) -> str:
    """Drop series/volume noise that defeats an exact title match.

    Removes trailing ``(Series, #3)`` parentheticals, ``Tom 3`` / ``Book II`` volume markers,
    and ``T.3`` shorthand, leaving the core title Google/OpenLibrary can match.
    """
    cleaned = re.sub(r"\s*\([^)]*\)\s*$", "", title)
    cleaned = re.sub(
        r"\s*[,.]?\s*(Tom|Book|Tome|Część|Czesc)\s+[\wIVX]+.*$", "", cleaned, flags=re.I
    )
    cleaned = re.sub(r"\s*T\.?\s*\d+.*$", "", cleaned)
    return cleaned.strip(" .,-") or title


def build_queries(title: str, author: str) -> list[str]:
    """Progressively looser queries: strict title+author, then title+author free text,
    then cleaned title+author, then just the cleaned title."""
    core = clean_title(title)
    queries: list[str] = []
    if author:
        queries.append(f'intitle:"{title}" inauthor:"{author}"')
        queries.append(f'intitle:"{core}" inauthor:"{author}"')
        queries.append(f"{core} {author}")
    queries.append(f'intitle:"{core}"')
    queries.append(core)
    # De-duplicate preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for q in queries:
        if q not in seen:
            seen.add(q)
            unique.append(q)
    return unique


async def _search_with_retry(
    client: GoogleBooksClient, query: str, *, retries: int = 4
) -> tuple[int, list]:
    """Search, backing off on HTTP 429 (rate limit)."""
    delay = 2.0
    for attempt in range(retries):
        try:
            return await client.search(query, max_results=1)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429 and attempt < retries - 1:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise
    return 0, []


async def _search_best(client: GoogleBooksClient, title: str, author: str) -> tuple[int, list]:
    """Try progressively looser queries, returning the first with a hit."""
    last: tuple[int, list] = (0, [])
    for query in build_queries(title, author):
        total, items = await _search_with_retry(client, query)
        if items:
            return total, items
        last = (total, items)
    return last


async def seed() -> None:
    settings = get_settings()
    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)

    # Without an API key Google Books throttles aggressively, so cap how many we fetch
    # per run and pace the requests. Override with SEED_LIMIT / SEED_DELAY.
    limit = int(os.environ.get("SEED_LIMIT", "40"))
    try:
        per_request_delay = float(os.environ.get("SEED_DELAY", "1.5").replace(",", "."))
    except ValueError:
        per_request_delay = 1.5

    titles = read_csv_titles(data_dir)
    if not titles:
        print("No CSV in data/ — using the built-in fallback list.")
        titles = FALLBACK_TITLES
    if limit > 0:
        titles = titles[:limit]

    if not settings.google_books_api_key:
        print(
            "No GOOGLE_BOOKS_API_KEY set — using the keyless quota, which is low. "
            "Pacing requests and fetching at most",
            limit,
            "books. Set a key in .env to seed more.",
        )

    await init_db(settings.database_file)
    conn = await connect(settings.database_file)
    inserted = skipped = failed = consecutive_429 = 0
    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            client = GoogleBooksClient(
                base_url=settings.google_books_base_url,
                api_key=settings.google_books_api_key,
                client=http,
            )
            for index, (title, author) in enumerate(titles):
                if index:
                    await asyncio.sleep(per_request_delay)
                try:
                    _total, items = await _search_best(client, title, author)
                    consecutive_429 = 0
                except httpx.HTTPStatusError as exc:
                    failed += 1
                    if exc.response.status_code == 429:
                        consecutive_429 += 1
                        print(f"  ! {title}: rate limited (429)")
                        if consecutive_429 >= 5:
                            print(
                                "\nStopping: hit the rate limit repeatedly. "
                                "Set GOOGLE_BOOKS_API_KEY in .env and re-run `just sample`."
                            )
                            break
                    else:
                        print(f"  ! {title}: request failed ({exc})")
                    continue
                except httpx.HTTPError as exc:
                    print(f"  ! {title}: request failed ({exc})")
                    failed += 1
                    continue
                if not items:
                    print(f"  ? {title}: no match")
                    failed += 1
                    continue
                volume = items[0]
                if volume.google_volume_id and await repo.find_by_volume_id(
                    conn, SINGLE_USER_ID, volume.google_volume_id
                ):
                    skipped += 1
                    continue
                payload = BookCreate(
                    **volume.model_dump(),
                    status=ReadingStatus.want,
                )
                await repo.create_book(conn, SINGLE_USER_ID, payload)
                inserted += 1
                print(f"  + {volume.title} — {', '.join(volume.authors) or 'unknown'}")
    finally:
        await conn.close()

    print(f"\nDone: {inserted} inserted, {skipped} already present, {failed} failed.")


if __name__ == "__main__":
    asyncio.run(seed())
