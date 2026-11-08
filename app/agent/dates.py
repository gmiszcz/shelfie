"""The current-date system note, shared by BOTH agents.

Neither the UI agent (``app.agent.ui_agent``) nor the librarian
(``app.agent.config.yaml`` / ``app.agent.engine``) has a clock of its own, so
without this they guess the year and in practice ask the user what year it is.
This module builds one note that states today's date, the current year, and that
a bare "this year" / "w tym roku" means books FINISHED in the current calendar
year. Both agents inject the SAME note **in code at each reply**, so it stays
correct across midnight in a long-lived session (it is rebuilt every turn from
:func:`now`, never baked into a static prompt or the YAML).
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
