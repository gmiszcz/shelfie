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
