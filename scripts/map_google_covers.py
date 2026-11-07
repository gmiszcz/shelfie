"""Find covers for books still without one, the way a person does it:
search Google Books by title (+ subtitle) and author, accept the same work in any edition.

Dry-run by default: prints the proposed match per book. Pass --apply to attach covers via
scripts.attach_cover (verifies the image, stores it in data/covers, updates JSON + DB).
"""

from __future__ import annotations

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
KEY = next(
    (
        line.split("=", 1)[1].strip()
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines()
        if line.startswith("GOOGLE_BOOKS_API_KEY=")
    ),
    "",
)


def norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s)


def words(s: str | None) -> set[str]:
    return {w for w in norm(s).split() if len(w) > 2 and w not in {"tom", "etap", "the", "ksiega", "czesc", "pierwszy", "drugi", "trzeci", "czwarty", "piaty", "szosty", "siodmy", "ksiegi", "cykl", "seria"}}


def surname(authors: list[str]) -> str:
    return norm(authors[0]).split()[-1] if authors else ""


def best_cover(book: dict) -> tuple[str, str] | None:
    title = book.get("title") or ""
    sub = book.get("subtitle") or ""
    authors = book.get("authors") or []
    sub_head = sub.split('.')[0]
    want = words(title + ' ' + sub_head)
    last = surname(authors)
    queries = [f'intitle:"{title}" {sub} inauthor:{last}', f"{title} {sub} {last}", f"{title} {last}"]
    for q in queries:
        for lang in ("pl", None):
            params = {"q": q, "maxResults": 20, "key": KEY, "printType": "books"}
            if lang:
                params["langRestrict"] = lang
            r = httpx.get("https://www.googleapis.com/books/v1/volumes", params=params, timeout=20)
            time.sleep(0.4)
            if r.status_code == 429:
                raise SystemExit("Google Books daily quota exhausted (HTTP 429); run again after the reset.")
            if r.status_code != 200:
                continue
            for item in r.json().get("items", []):
                v = item.get("volumeInfo", {})
                links = v.get("imageLinks") or {}
                img = links.get("thumbnail") or links.get("smallThumbnail")
                if not img:
                    continue
                got = words(f"{v.get('title', '')} {v.get('subtitle', '')}")
                vauth = " ".join(norm(a) for a in v.get("authors", []))
                # Same work: every significant word of our title+subtitle appears, and the
                # author's surname matches (transliteration variants share the first 5 letters).
                author_ok = not last or any(SequenceMatcher(None, last, w).ratio() >= 0.7 for w in vauth.split())
                if want and want <= got and author_ok:
                    url = img.replace("http://", "https://").replace("&edge=curl", "")
                    url = re.sub(r"zoom=\d", "zoom=1", url) + "&fife=w800"
                    return url, f"{v.get('title')} | {v.get('subtitle') or ''} | {', '.join(v.get('authors', []))}"
    return None


def main() -> None:
    apply = "--apply" in sys.argv
    books = json.loads((ROOT / "data" / "books.json").read_text(encoding="utf-8"))["books"]
    missing = [b for b in books if not b.get("cover_url")]
    print(f"missing: {len(missing)}")
    found = 0
    for b in missing:
        hit = best_cover(b)
        label = f"{b.get('title')} / {b.get('subtitle') or ''}"
        if not hit:
            print(f"NO   {label}")
            continue
        found += 1
        print(f"OK   {label}  ->  {hit[1]}")
        if apply:
            res = subprocess.run(
                [sys.executable, "-m", "scripts.attach_cover", "--external-id", str(b["external_id"]),
                 "--url", hit[0], "--root", str(ROOT)],
                cwd=ROOT, capture_output=True, text=True, timeout=55,
            )
            print("     attach:", (res.stdout or res.stderr).strip().splitlines()[-1:])
    print(f"found {found} of {len(missing)}")


if __name__ == "__main__":
    main()



