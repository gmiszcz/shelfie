"""The current-date note for the assistant.

The model has no clock of its own, so without this it guesses the year and asks
the user what year it is. This module builds one note that states today's date,
the current year, and that a bare "this year" / "w tym roku" means books FINISHED
in the current calendar year. ``app.agent.sessions`` adds it to the AG-UI client
context **on every run**, so it stays correct across midnight in a long-lived
session (rebuilt from :func:`now`, never baked into the YAML).
"""

from __future__ import annotations

from datetime import datetime


def now() -> datetime:
    """The current local date/time. A seam so the date block is testable."""
    return datetime.now().astimezone()


def date_system_block(moment: datetime | None = None) -> str:
    """A system note giving the model the current date, so "this year" etc. resolve.

    States today's date, the current year, and that a bare "this year" / "w tym
    roku" means books FINISHED in the current calendar year by default. The note
    forbids asking the user which year it is.

    Args:
        moment: The reference time; defaults to :func:`now` (rebuilt every call,
            so a long session stays correct across midnight).
    """
    stamp = moment or now()
    tz = stamp.tzname() or "local"
    return (
        f"Today is {stamp.strftime('%Y-%m-%d')} ({stamp.strftime('%A')}), "
        f"timezone {tz}. The current year is {stamp.year}. "
        f'When the user says "this year" / "w tym roku" it means books FINISHED in '
        f"{stamp.year} (finished_on in {stamp.year}) unless they say otherwise; "
        f'"last year" / "w zeszłym roku" means {stamp.year - 1}. Resolve any relative '
        f"period (this/last year, recent months) against this date and NEVER ask the "
        f"user what year it is."
    )
