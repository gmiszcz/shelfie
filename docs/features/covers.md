# Covers & cycle-metadata maintenance (Wave 4)

Two one-off maintenance scripts repair catalogue data in `data/books.json` **and** the live
SQLite database the backend reads. Both are safe to re-run, back up before they write, update the
database only with targeted `UPDATE`s by book id, never touch the `comparisons` table or any user
reading data, and assert the comparison count is unchanged before/after.

Shared helpers live in `scripts/_dataio.py`:

- `backup_data` copies `books.json` and `shelfie.sqlite` (plus any WAL/SHM sidecars) into
  `data/backup-wave4-<timestamp>/` before any mutation.
- `load_db_index` / `match_db_id` map a JSON record to exactly one `books.id` by identity
  (Google volume id -> ISBN-13 -> ISBN-10 -> external id -> title+authors). A key that is
  ambiguous in the database (e.g. a duplicated volume id) is dropped from the lookup, so a record
  is never matched to the wrong row.
- `count_comparisons` reads the rating-engine log so the scripts can prove it is intact.

JSON is written atomically (temp file + `os.replace`), after every book, so an interruption keeps
all progress so far. Database writes use `PRAGMA busy_timeout` so they coexist with the running
read-only backend without restarting it.

## Task A — `scripts/fill_covers.py`

Finds a real cover for every book whose `cover_url` is empty, verifies it is a genuine image,
downloads it into the app's cover storage (`data/covers/`, the same place the `/api/covers`
upload endpoint writes), and sets `cover_url` to the resulting `/api/covers/<name>` in both
stores. Storing the file locally (rather than a remote URL) means the cover keeps working even if
the upstream URL later changes or disappears.

Sources are tried in order and are **all keyed to the specific book**, so a cover is never guessed
from the top hit of a free-text search that might be a different edition:

1. Google Books by ISBN-13, then ISBN-10.
2. The record's own Google volume id (`books.google.com/books/content?id=<volume_id>&...&fife=w800`).
3. Google Books by title + author, restricted to the book's language.
4. OpenLibrary covers by ISBN-13, then ISBN-10 (`?default=false`).
5. OpenLibrary search by title + author.

A candidate is accepted only when it returns HTTP 200, an image content type (sniffed from the
bytes, with the declared `image/*` type as a fallback), and a body larger than 2 KB. The 2 KB
floor is what rejects Google's ~1.3 KB "no cover available" placeholder, so a placeholder is never
stored. Requests are spaced out and back off on HTTP 429 (honouring `Retry-After`).

```
just fill-covers --root E:\WebDev\shelfie            # apply
just fill-covers --root E:\WebDev\shelfie --dry-run  # report only, write nothing
just fill-covers --dry-run --limit 5                 # first 5 only
just fill-covers --no-download                       # store the verified URL, not a local file
```

(`--root` points the script at the live checkout when it is run from a worktree; it defaults to
the script's own repository.)

### Covers that stay missing

Many of the un-covered books are catalogue-only editions (Google volume ids ending `...ACAAJ`)
whose Polish editions have no cover in Google Books or OpenLibrary by ISBN, volume id, or
title+author. Polish retail sites that do host these covers (empik, lubimyczytac) block automated
requests (HTTP 403) or serve markup from which a *specific* book's cover cannot be reliably
extracted, so trusting their top search hit risks attaching the wrong cover to a book. Rather than
store a cover that might belong to a different book, the script leaves those `cover_url` empty and
reports each one. They can be filled by hand through the existing cover-upload UI.

### Attaching a known cover by hand — `scripts/attach_cover.py`

For a book `fill_covers` left empty, a cover can be found by hand and attached with
`scripts/attach_cover.py`, one book at a time. It takes the book's `external_id` and an image URL,
downloads it with a normal browser `User-Agent`, verifies it is a genuine image (the SAME 2 KB /
content-type check as `fill_covers`, so placeholders and HTML error pages are rejected), stores it
in `data/covers/` and writes the `/api/covers/<name>` URL into both `books.json` and the SQLite DB
(targeted `UPDATE` by id; `comparisons` untouched; count asserted unchanged):

```
python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg
python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg --dry-run
python -m scripts.attach_cover --external-id 21357301 --url https://.../cover.jpg --root E:\WebDev\shelfie
```

`attach(..., make_backup=False)` lets a batch caller take a single shared backup up front instead
of one per book.

**taniaksiazka.pl is the reliable source for these Polish editions.** Its product pages are served
to a browser `User-Agent` (unlike empik, which returns 403) and host the cover on the
`cf-tk.statiki.pl` CDN at `…/images/large-x2/<DIR>/<ISBN13>.webp` — the cover filename *is* the
book's ISBN-13, so a match is ISBN-exact by construction. The safe procedure, applied in the
`feat/covers-web` pass that filled 22 of these books:

1. Search the shop by the book's ISBN-13 (`/Szukaj/q-<isbn>`); take the `…-p-<id>.html` product
   link and read the `large-x2` cover whose filename equals the book's ISBN. **ISBN-exact — accept.**
2. If the ISBN is not stocked, search by title + author. Accept a hit **only** when the product's
   title AND author (AND volume, for a series) match exactly — a re-edition of the same book shares
   its cover art. The top search hit is usually a *different* volume of the same series, so this
   step is verified by hand, never auto-accepted. Books where no confident match exists are left
   empty. The still-empty set is dominated by series volumes taniaksiazka does not currently stock
   (several *Kroniki Riyrii*, *Czarne kamienie* and *Droga Szamana* volumes) and a few standalones
   with no shop listing.

## Task B — `scripts/fix_series_titles.py`

Repairs cycle metadata on books whose title carries only the series name, with the real volume
title stranded in the subtitle or missing, and on volumes missing their series/volume link. The
corrections are an explicit, verified table keyed by `external_id`; only these catalogue fields
are ever written: `title`, `subtitle`, `series`, `volume`, `description`. Reading data is never in
the set.

- **The Way of the Shaman / Droga Szamana** (Mahanenko, Insignis). Volume subtitles are normalised
  to the publisher forms (`Początek. Etap pierwszy`, `Gambit Kartosa. Etap drugi`,
  `Tajemnica Mrocznego Lasu. Etap trzeci`, `Szachy Karmadonta. Etap piąty`,
  `Na tropie stwórcy. Etap siódmy`), the missing description on volume 5 is filled from the
  publisher blurb, and the series is set on the volumes that lacked it — including the two
  English-titled editions (#4 *The Phantom Castle*, #6 *Shaman's Revenge*). The series name is
  kept as the English `The Way of the Shaman`, because that is the form the library already uses on
  the volumes that had a series set; the Polish title `Droga Szamana` stays in the `title` field.
- **Dar anomalii** (Zbroszczyk). Volume 1 (which carries only `Ks. 1` — it has no distinct volume
  title) gets its missing `series`/`volume` link, and volume 2's series casing is normalised from
  `Dar Anomalii` to `Dar anomalii`.

`--scan` additionally lists every book whose title equals its series name. After the fixes the only
such books are the three `Dar anomalii` volumes, all handled above.

```
just fix-series --root E:\WebDev\shelfie             # apply
just fix-series --root E:\WebDev\shelfie --dry-run --scan
```

## Mapping covers by title and author (any edition)

Some Polish editions have no cover on their own Google volume, while another edition of the same work does. `just map-google-covers` searches Google Books by title (plus the first part of the subtitle) and author, accepts a hit when every significant title word matches and the author surname is a close spelling (e.g. Machanienko / Mahanenko), and with `--apply` attaches the cover through `scripts/attach_cover.py` (image verified, stored in `data/covers/`, JSON + DB updated, comparisons untouched). It stops on HTTP 429, the Google Books daily quota.

