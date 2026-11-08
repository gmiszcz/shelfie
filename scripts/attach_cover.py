"""Attach one known cover image URL to one book, in both data stores (Wave 4, Task A helper).

``fill_covers`` resolves covers automatically from Google Books and OpenLibrary, which is enough
for most books but leaves the catalogue-only Polish editions empty (see ``docs/features/covers.md``).
For those, a cover URL is found by hand (a web search plus a product page on a Polish bookshop or
publisher site) and attached with this helper, one book at a time.

Given a book's ``external_id`` and an image URL, this script:

1. Downloads the image with a normal browser ``User-Agent`` header.
2. Verifies it is a genuine image (``image/*`` content type, larger than the placeholder floor)
   using the SAME verification as ``fill_covers`` -- so a shop's "no image" placeholder, an HTML
   error page served as 200, or a tracking pixel is rejected, never stored.
3. Stores it into the app's cover storage (``data/covers/``) via ``fill_covers.store_cover``.
4. Writes the resulting ``/api/covers/<name>`` URL into BOTH ``data/books.json`` (atomic write)
   and the live SQLite database (a targeted ``UPDATE`` by book id; the ``comparisons`` table is
   never touched), matching the DB row with ``_dataio.match_db_id``.

The comparison count is read before and after and asserted unchanged, exactly like the batch
script, so attaching a cover can never disturb the rating log or any reading data.

    python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg
    python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg --dry-run
    python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg \
        --root E:\\WebDev\\shelfie
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import _dataio, fill_covers  # noqa: E402

# A normal browser UA: Polish bookshops and publisher CDNs serve the real image to a browser
# but may refuse or redirect an unadorned client.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


def find_record(books: list[dict[str, Any]], external_id: str) -> dict[str, Any] | None:
    """Locate the JSON record for ``external_id``."""
    for book in books:
        if str(book.get("external_id") or "") == str(external_id):
            return book
    return None


def verify_image_bytes(data: bytes, declared: str | None) -> str | None:
    """Return a content type when ``data`` is a real image, else ``None``.

    Reuses ``fill_covers``'s byte floor and magic-byte sniff so the accept/reject rule is
    identical to the batch script. ``declared`` is the response's ``Content-Type`` header,
    used only as a fallback when the bytes do not sniff.
    """
    if len(data) < fill_covers.MIN_IMAGE_BYTES:
        return None
    sniffed = fill_covers._sniff_image(data)
    if sniffed:
        return sniffed
    declared = (declared or "").split(";")[0].strip().lower()
    return declared if declared.startswith("image/") else None


def attach(
    root: Path,
    external_id: str,
    url: str,
    *,
    dry_run: bool,
    client: httpx.Client | None = None,
    make_backup: bool = True,
    user: str = "1",
) -> int:
    """Attach ``url`` as the cover for the book with ``external_id``. Returns a process exit code."""
    paths = _dataio.resolve_user_paths(root, user)
    data_dir = paths.data_dir
    dataset_file = paths.dataset_file
    db_file = paths.db_file
    covers_dir = paths.covers_dir

    payload = _dataio.load_dataset(dataset_file)
    books: list[dict[str, Any]] = payload["books"]
    record = find_record(books, external_id)
    if record is None:
        print(f"ERROR: no book with external_id {external_id!r} in {dataset_file}", file=sys.stderr)
        return 2
    if (record.get("cover_url") or "").strip():
        print(f"SKIP: {record.get('title')!r} already has a cover ({record['cover_url']})")
        return 0

    owns_client = client is None
    if client is None:
        client = httpx.Client(timeout=20.0, follow_redirects=True, headers=BROWSER_HEADERS)
    try:
        resp = client.get(url, headers=BROWSER_HEADERS)
    except httpx.HTTPError as exc:
        print(f"ERROR: fetch failed for {url}: {exc}", file=sys.stderr)
        if owns_client:
            client.close()
        return 3
    finally:
        if owns_client and not dry_run:
            pass
    status = resp.status_code
    content_type = verify_image_bytes(resp.content, resp.headers.get("Content-Type"))
    if owns_client:
        client.close()

    if status != 200 or content_type is None:
        size = len(resp.content)
        print(
            f"ERROR: {url} did not verify as an image (status={status}, bytes={size}, "
            f"declared={resp.headers.get('Content-Type')!r})",
            file=sys.stderr,
        )
        return 3

    if dry_run:
        print(
            f"OK (dry-run): {record.get('title')!r} <- {url} "
            f"({content_type}, {len(resp.content)} bytes)"
        )
        return 0

    if make_backup:
        backup = _dataio.backup_data(data_dir, db_file, dataset_file)
        print(f"Backup: {backup}")

    conn = _dataio.connect_db(db_file)
    comparisons_before = _dataio.count_comparisons(conn)
    try:
        index = _dataio.load_db_index(conn)
        db_id = _dataio.match_db_id(record, index)
        cover_url = fill_covers.store_cover(covers_dir, resp.content, content_type)
        record["cover_url"] = cover_url
        _dataio.atomic_write_json(dataset_file, payload)
        if db_id is not None:
            conn.execute(
                "UPDATE books SET cover_url = ?, updated_at = datetime('now') "
                "WHERE user_id = ? AND id = ?",
                (cover_url, _dataio.SINGLE_USER_ID, db_id),
            )
            conn.commit()
            print(f"OK: {record.get('title')!r} -> {cover_url} (db id {db_id})")
        else:
            print(
                f"WARN: {record.get('title')!r} -> {cover_url} (JSON only; no DB match)",
                file=sys.stderr,
            )
    finally:
        comparisons_after = _dataio.count_comparisons(conn)
        conn.close()

    if comparisons_before != comparisons_after:
        print(
            f"ERROR: comparison count changed ({comparisons_before} -> {comparisons_after})!",
            file=sys.stderr,
        )
        return 1
    print(f"Comparisons before={comparisons_before} after={comparisons_after}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--external-id", required=True, help="the book's external_id in books.json")
    parser.add_argument("--url", required=True, help="image URL of the cover to attach")
    parser.add_argument("--dry-run", action="store_true", help="verify only, write nothing")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="repository root whose data/ to edit (default: this script's repo)",
    )
    parser.add_argument(
        "--user",
        default="1",
        help="user id or e-mail whose library to edit (default: 1, the first admin)",
    )
    args = parser.parse_args()
    root = args.root or Path(__file__).resolve().parents[1]
    sys.exit(attach(root, args.external_id, args.url, dry_run=args.dry_run, user=args.user))


if __name__ == "__main__":
    main()
