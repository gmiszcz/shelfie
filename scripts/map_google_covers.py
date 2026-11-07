"""Find covers for books still without one, the way a person does it:
search Google Books by title (+ subtitle) and author, accept the same work in any edition.

Dry-run by default: prints the proposed match per book. Pass --apply to attach covers via
scripts.attach_cover (verifies the image, stores it in data/covers, updates JSON + DB).
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def _read_api_key(root: Path) -> str:
    """Read GOOGLE_BOOKS_API_KEY from the checkout's .env, tolerating a missing file."""
    env = root / ".env"
    if not env.is_file():
        return ""
    return next(
        (
            line.split("=", 1)[1].strip()
            for line in env.read_text(encoding="utf-8").splitlines()
            if line.startswith("GOOGLE_BOOKS_API_KEY=")
        ),
        "",
    )


KEY = _read_api_key(ROOT)


def norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s)


def words(s: str | None) -> set[str]:
    return {
        w
        for w in norm(s).split()
        if len(w) > 2
        and w
        not in {
            "tom",
            "etap",
            "the",
            "ksiega",
            "czesc",
            "pierwszy",
            "drugi",
            "trzeci",
            "czwarty",
            "piaty",
            "szosty",
            "siodmy",
            "ksiegi",
            "cykl",
            "seria",
        }
    }


def surname(authors: list[str]) -> str:
    return norm(authors[0]).split()[-1] if authors else ""


CACHE_DIR = ROOT / "data" / "cache" / "google_books"
CALLS = [0]


def google_search(q: str) -> list[dict]:
    """One Google Books search, cached on disk (the API key is never part of the cache key)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(q.encode("utf-8")).hexdigest()[:32]
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8")).get("items", [])
    r = httpx.get(
        "https://www.googleapis.com/books/v1/volumes",
        params={"q": q, "maxResults": 20, "key": KEY, "printType": "books"},
        timeout=20,
    )
    CALLS[0] += 1
    if r.status_code == 429:
        raise SystemExit(
            f"Google Books quota exhausted (HTTP 429) after {CALLS[0]} calls; nothing retried."
        )
    r.raise_for_status()
    path.write_text(json.dumps({"q": q, **r.json()}, ensure_ascii=False), encoding="utf-8")
    time.sleep(0.4)
    return r.json().get("items", [])


def best_cover(book: dict) -> tuple[str, str] | None:
    """Exactly ONE search per book (title + first part of subtitle + first author)."""
    title = book.get("title") or ""
    sub_head = (book.get("subtitle") or "").split(".")[0]
    authors = book.get("authors") or []
    want = words(title + " " + sub_head)
    last = surname(authors)
    q = f"{title} {sub_head} {authors[0] if authors else ''}".strip()
    for item in google_search(q):
        v = item.get("volumeInfo", {})
        links = v.get("imageLinks") or {}
        img = links.get("thumbnail") or links.get("smallThumbnail")
        if not img:
            continue
        got = words(f"{v.get('title', '')} {v.get('subtitle', '')}")
        vauth = " ".join(norm(a) for a in v.get("authors", []))
        # Same work: every significant title word appears, and the author surname is a close
        # spelling (transliterations such as Machanienko / Mahanenko).
        author_ok = not last or any(
            SequenceMatcher(None, last, w).ratio() >= 0.7 for w in vauth.split()
        )
        if want and want <= got and author_ok:
            url = img.replace("http://", "https://").replace("&edge=curl", "")
            url = re.sub(r"zoom=\d", "zoom=1", url) + "&fife=w800"
            return (
                url,
                f"{v.get('title')} | {v.get('subtitle') or ''} | {', '.join(v.get('authors', []))}",
            )
    return None


def main() -> None:
    import argparse

    from scripts import _dataio

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Attach the found covers")
    parser.add_argument("--root", default=str(ROOT), help="Checkout root (default: this repo)")
    parser.add_argument(
        "--user",
        default="1",
        help="User id or e-mail whose library to map (default: 1, the first admin)",
    )
    args = parser.parse_args()

    root = Path(args.root)
    paths = _dataio.resolve_user_paths(root, args.user)
    if not paths.dataset_file.is_file():
        raise SystemExit(f"no dataset for user {paths.user_id} at {paths.dataset_file}")

    books = json.loads(paths.dataset_file.read_text(encoding="utf-8"))["books"]
    missing = [b for b in books if not b.get("cover_url")]
    print(f"user {paths.user_id}: missing {len(missing)}")
    found = 0
    for b in missing:
        hit = best_cover(b)
        label = f"{b.get('title')} / {b.get('subtitle') or ''}"
        if not hit:
            print(f"NO   {label}")
            continue
        found += 1
        print(f"OK   {label}  ->  {hit[1]}")
        if args.apply:
            res = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "scripts.attach_cover",
                    "--external-id",
                    str(b["external_id"]),
                    "--url",
                    hit[0],
                    "--root",
                    str(root),
                    "--user",
                    str(paths.user_id),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=55,
            )
            print("     attach:", (res.stdout or res.stderr).strip().splitlines()[-1:])
    print(f"found {found} of {len(missing)}; Google calls this run: {CALLS[0]}")


if __name__ == "__main__":
    main()
