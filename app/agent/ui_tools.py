"""Frontend ("UI") tools for the library assistant's UI-control scope.

These tools do **not** touch the database or the server. Each one is a thin
stub whose only job is to let the model *express an intent to change the UI*.
When the agent calls one, strands streams a ``TOOL_CALL_START`` / ``ARGS`` /
``TOOL_CALL_RESULT`` sequence (see :mod:`app.agent.agui`); the browser reads
that sequence and performs the real effect by dispatching the ``shelfie:ui``
``CustomEvent`` described in the wave-2 UI-bus contract. The stub returns a
small confirmation so the agent's turn can continue and summarise what it did.

The tool arguments mirror the ``detail`` shapes of the ``shelfie:ui`` contract:

- ``filter_library(query?, series?, author?, shelf?, tag?, status?, min_stars?)``
- ``clear_filter()``
- ``navigate(tab)``  — ``"library" | "stats" | "ranking"``
- ``open_book(book_id)``

The agent should resolve real values first with the data tools (e.g. call
``search_library`` to find the exact series name) and only then call a UI tool.
"""

from __future__ import annotations

from typing import Any

from strands import tool

_TABS = {"library", "stats", "ranking"}


@tool
def filter_library(
    query: str = "",
    series: str = "",
    author: str = "",
    shelf: str = "",
    tag: str = "",
    status: str = "",
    min_stars: float = 0.0,
) -> dict[str, Any]:
    """Filter the on-screen library grid. Switches to the Library tab first.

    Pass only the facets you want to constrain; leave the rest empty/zero.
    Resolve names with search_library before calling (use the exact series or
    author string the library stores).

    Args:
        query: Free-text filter (title/author/series), e.g. "Sanderson".
        series: Exact series name, e.g. "Droga Szamana".
        author: Exact author name.
        shelf: Shelf name, e.g. "Fantasy".
        tag: Tag name, e.g. "Magia".
        status: One of want, reading, finished, abandoned.
        min_stars: Minimum star rating (0.5..5.0); 0 means no minimum.
    """
    detail: dict[str, Any] = {"action": "filter_library"}
    if query.strip():
        detail["query"] = query.strip()
    if series.strip():
        detail["series"] = series.strip()
    if author.strip():
        detail["author"] = author.strip()
    if shelf.strip():
        detail["shelf"] = shelf.strip()
    if tag.strip():
        detail["tag"] = tag.strip()
    if status.strip():
        detail["status"] = status.strip().lower()
    if min_stars and min_stars > 0:
        detail["min_stars"] = float(min_stars)
    return {"ok": True, "ui_action": detail}


@tool
def clear_filter() -> dict[str, Any]:
    """Remove the assistant's library filter and show the whole library again."""
    return {"ok": True, "ui_action": {"action": "clear_filter"}}


@tool
def navigate(tab: str) -> dict[str, Any]:
    """Switch the active page.

    Args:
        tab: One of "library", "stats" or "ranking".
    """
    target = tab.strip().lower()
    if target not in _TABS:
        return {"error": f"unknown tab {tab!r}; expected one of {sorted(_TABS)}"}
    return {"ok": True, "ui_action": {"action": "navigate", "tab": target}}


@tool
def open_book(book_id: int) -> dict[str, Any]:
    """Open the detail dialog for one book.

    Args:
        book_id: The book id returned by search_library or list_books.
    """
    return {"ok": True, "ui_action": {"action": "open_book", "book_id": int(book_id)}}


# The strands @tool decorator wraps each function; expose the callables so the
# engine can register them on an agent in UI-control scope.
UI_TOOLS = [filter_library, clear_filter, navigate, open_book]
