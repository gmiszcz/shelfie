"""Repair series, volume, subtitle and description on cycle books (Wave 4, Task B).

Some imported books carry only the SERIES name as their title, with the real volume title
missing or stranded in the subtitle, and some are missing the series/volume link entirely.
This script applies a small, explicit set of verified corrections to ``data/books.json`` and the
live SQLite database (a targeted ``UPDATE`` by book id; the ``comparisons`` table and all user
reading data -- dates, stars, shelves, tags, notes, review -- are never touched).

The corrections are keyed by ``external_id`` (stable and unique per record) and list only the
catalogue fields that change (``title``, ``subtitle``, ``series``, ``volume``, ``description``).
The volume titles and the series name were verified against the publishers (Insignis for
``The Way of the Shaman`` / ``Droga Szamana``; the Polish editions of ``Dar anomalii``).

The series name is reported for the Shaman cycle: the library already uses the English form
``The Way of the Shaman`` on the volumes that have a series set, so this script keeps that form
consistently across every volume of the cycle (the Polish title ``Droga Szamana`` stays in the
``title`` field, where the import put it).

    python -m scripts.fix_series_titles             # apply the corrections
    python -m scripts.fix_series_titles --dry-run   # report what would change, write nothing
    python -m scripts.fix_series_titles --scan       # also list title==series books not yet fixed

Run it from a worktree with ``--root <live checkout>`` to edit the live data, e.g.
``python -m scripts.fix_series_titles --root E:\\WebDev\\shelfie``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import _dataio  # noqa: E402

# Only these catalogue fields may be written by this script. Reading data is never in the set.
EDITABLE_FIELDS = ("title", "subtitle", "series", "volume", "description")

SHAMAN_SERIES = "The Way of the Shaman"

# Verified Polish publisher blurb for volume 5 (Szachy Karmadonta), which has no description.
_SZACHY_KARMADONTA_DESC = (
    "Barliona. Wirtualny świat przygód i tajemnic. Świat, w którym gracze spragnieni tego, "
    "czego w prawdziwym życiu nigdy nie zaznają, realizują swoje najśmielsze marzenia. "
    "Przebywasz tu online całymi miesiącami. Zamknięty w kapsule podtrzymującej funkcje "
    "życiowe, ścigasz się z innymi w levelowaniu postaci i zdobywasz kolejne osiągnięcia. "
    "Tu niemal wszystko jest dozwolone. I możesz całkiem nieźle zarobić. Chyba że jesteś "
    "więźniem. Wtedy to, co dla innych jest rozrywką, dla ciebie może stać się udręką.\n\n"
    "Machan myśli zapewne, że po ostatniej niespodziewanej lawinie wydarzeń jego życie w "
    "Barlionie potoczy się utartymi koleinami. Przecież ucichły już wichry Mrocznego Lasu, "
    "zamek Altameda ma swojego właściciela, a Gieranika, cóż… Ten jak knuł, tak knuje."
)

# external_id -> {field: new_value}. Only fields that actually change are listed; the runner
# skips a field whose current value already equals the target.
CORRECTIONS: dict[str, dict[str, str]] = {
    # --- The Way of the Shaman / Droga Szamana (Mahanenko, Insignis) ---
    "743909": {  # vol 1
        "subtitle": "Początek. Etap pierwszy",
        "series": SHAMAN_SERIES,
        "volume": "1",
    },
    "743912": {  # vol 2
        "subtitle": "Gambit Kartosa. Etap drugi",
        "series": SHAMAN_SERIES,
        "volume": "2",
    },
    "743916": {  # vol 3 — fix subtitle capitalization to the publisher form
        "subtitle": "Tajemnica Mrocznego Lasu. Etap trzeci",
        "series": SHAMAN_SERIES,
        "volume": "3",
    },
    "2270250": {  # vol 5 — set series, normalize subtitle, fill the missing description
        "subtitle": "Szachy Karmadonta. Etap piąty",
        "series": SHAMAN_SERIES,
        "volume": "5",
        "description": _SZACHY_KARMADONTA_DESC,
    },
    "5121781": {  # vol 7 — normalize subtitle to the publisher form
        "subtitle": "Na tropie stwórcy. Etap siódmy",
        "series": SHAMAN_SERIES,
        "volume": "7",
    },
    "994326": {  # #4, English edition — link to the series
        "series": SHAMAN_SERIES,
        "volume": "4",
    },
    "2333554": {  # #6, English edition — link to the series
        "series": SHAMAN_SERIES,
        "volume": "6",
    },
    # --- Dar anomalii (Zbroszczyk). Vol 1 carries only "Ks. 1" (no distinct volume title). ---
    "9121410": {  # vol 1 — add the missing series/volume link
        "series": "Dar anomalii",
        "volume": "1",
    },
    "12570869": {  # vol 2 — normalize the series casing ("Dar Anomalii" -> "Dar anomalii")
        "series": "Dar anomalii",
    },
}


def _record_index(books: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(b.get("external_id")): b for b in books if b.get("external_id") is not None}


def apply_correction(record: dict[str, Any], changes: dict[str, str]) -> dict[str, tuple[Any, Any]]:
    """Apply only the fields that differ. Returns ``{field: (old, new)}`` of what changed."""
    applied: dict[str, tuple[Any, Any]] = {}
    for field, new_value in changes.items():
        if field not in EDITABLE_FIELDS:
            continue
        old_value = record.get(field)
        if old_value == new_value:
            continue
        record[field] = new_value
        applied[field] = (old_value, new_value)
    return applied


def scan_title_equals_series(books: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Books whose title equals their series name (the real title is in subtitle or missing)."""
    hits = []
    for b in books:
        title = (b.get("title") or "").strip()
        series = (b.get("series") or "").strip()
        if title and series and title.casefold() == series.casefold():
            hits.append(b)
    return hits


def run(root: Path, *, dry_run: bool, scan: bool) -> int:
    data_dir = root / "data"
    dataset_file = data_dir / "books.json"
    db_file = data_dir / "shelfie.sqlite"

    payload = _dataio.load_dataset(dataset_file)
    books: list[dict[str, Any]] = payload["books"]
    by_ext = _record_index(books)

    if not dry_run:
        backup = _dataio.backup_data(data_dir, db_file, dataset_file)
        print(f"Backup: {backup}")

    conn = _dataio.connect_db(db_file)
    comparisons_before = _dataio.count_comparisons(conn)
    index = _dataio.load_db_index(conn)

    changed_books = 0
    missing_refs: list[str] = []
    try:
        for ext_id, changes in CORRECTIONS.items():
            record = by_ext.get(ext_id)
            if record is None:
                missing_refs.append(ext_id)
                print(f"  SKIP  external_id {ext_id}: not in dataset")
                continue
            applied = apply_correction(record, changes)
            title = record.get("title") or "?"
            if not applied:
                print(f"  ok    {title!r} (ext {ext_id}): already correct")
                continue

            db_id = _dataio.match_db_id(record, index)
            if dry_run:
                changed_books += 1
                for field, (old, new) in applied.items():
                    print(f"  DRY   {title!r} (ext {ext_id}) {field}: {old!r} -> {new!r}")
                continue

            _dataio.atomic_write_json(dataset_file, payload)
            if db_id is not None:
                sets = ", ".join(f"{f} = ?" for f in applied)
                values = [applied[f][1] for f in applied]
                values += [_dataio.SINGLE_USER_ID, db_id]
                conn.execute(
                    f"UPDATE books SET {sets}, updated_at = datetime('now') "  # nosec B608 - fields from a constant allowlist
                    "WHERE user_id = ? AND id = ?",
                    tuple(values),
                )
                conn.commit()
                changed_books += 1
                for field, (old, new) in applied.items():
                    print(
                        f"  FIX   {title!r} (ext {ext_id}) {field}: {old!r} -> {new!r} (db id {db_id})"
                    )
            else:
                missing_refs.append(ext_id)
                print(f"  WARN  {title!r} (ext {ext_id}): no DB match; JSON updated only")
    finally:
        comparisons_after = _dataio.count_comparisons(conn)
        conn.close()

    print("\n=== Task B summary ===")
    print(f"Books changed: {changed_books}")
    if missing_refs:
        print(f"Unmatched external_ids: {missing_refs}")
    print(f"Shaman cycle series name kept as: {SHAMAN_SERIES!r}")

    if scan:
        print("\n=== title == series scan (real title in subtitle or missing) ===")
        for b in scan_title_equals_series(books):
            print(
                f"  external_id={b.get('external_id')} title={b.get('title')!r} "
                f"subtitle={b.get('subtitle')!r} volume={b.get('volume')!r} "
                f"authors={b.get('authors')}"
            )

    print(f"\nComparisons before={comparisons_before} after={comparisons_after}")
    if comparisons_before != comparisons_after:
        print("ERROR: comparison count changed!", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument(
        "--scan", action="store_true", help="also list title==series books after applying fixes"
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="repository root whose data/ to edit (default: this script's repo).",
    )
    args = parser.parse_args()
    root = args.root or Path(__file__).resolve().parents[1]
    sys.exit(run(root, dry_run=args.dry_run, scan=args.scan))


if __name__ == "__main__":
    main()
