"""Release-research step: find a series' next volume on the open web (wave 6 rework).

Two small strands agents on Bedrock (the same model and env wiring as the chat engine
and the enrichment step, built by :func:`_build_model`) run in sequence:

* a **RESEARCHER** agent searches the open web in ONLY the requested language(s) with the
  existing ``web_search`` / ``fetch_url`` tools (never Google Books), sharing one per-run
  :class:`CallBudget`. For ``pl`` it searches Polish publishers (e.g. Fabryka Słów for
  Kroniki Mroku), lubimyczytac.pl and empik.com; for ``en`` the author's site, Goodreads
  and Amazon;
* an **EDITOR** agent turns the researcher's findings into one strict
  :class:`ReleaseSummary`: a coarse ``status``, ONE factual Polish ``headline`` sentence
  (the style of Google's AI answer), a CLEAN ``next_title`` (the real book title, never a
  series-tagged string like ``"King's Dark Tidings (Kroniki mroku tom 7)"``), the
  ``next_volume`` number, a free-text ``expected_date``, Polish ``details`` bullets each
  with a ``source_url``, and per-language ``editions``.

The model is told to NEVER invent a date. Any model/transport/validation error yields an
all-``unknown`` summary (empty ``headline``) so a watch-on / refresh never fails because
research did. Tests inject a fake ``model`` (and may pre-seed the web cache) so no test
touches AWS or the network.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

from app.config import Settings, get_settings
from app.integrations import web_research
from app.integrations.web_research import CallBudget
from app.schemas.series import ReleaseSummary

if TYPE_CHECKING:
    from strands.models.model import Model

logger = logging.getLogger(__name__)

# The coarse status values the editor must choose from.
_STATUS_VALUES = ("released", "announced", "in_translation", "no_news", "unknown")

# Backwards-compatible per-edition result used by the service to keep next_expected_pl/en.
from pydantic import BaseModel, Field  # noqa: E402


class EditionResult(BaseModel):
    """One edition's next-volume finding (kept for next_expected_pl/en compatibility)."""

    title: str | None = None
    date: str | None = None
    status: str = "unknown"  # "announced" | "released" | "in_translation" | "unknown"
    source_url: str | None = None
    confidence: str | None = None  # "high" | "medium" | "low"


class ResearchResult(BaseModel):
    """The full result: the clean editor summary plus per-edition rows for compatibility."""

    summary: ReleaseSummary = Field(default_factory=ReleaseSummary)
    pl: EditionResult = Field(default_factory=EditionResult)
    en: EditionResult = Field(default_factory=EditionResult)


def _langs(search_lang: str) -> list[str]:
    """Resolve a search_lang into the concrete language list to research."""
    if search_lang == "both":
        return ["pl", "en"]
    return [search_lang] if search_lang in ("pl", "en") else ["pl"]


_RESEARCHER_PROMPT = (
    "You research book-series release information on the open web. You are given a series, "
    "its author, the volume numbers the user already owns, and the LANGUAGE(S) to search. "
    "Find the NEXT volume AFTER the highest owned number.\n\n"
    "SEARCH ONLY THE REQUESTED LANGUAGE(S):\n"
    "- pl: search the Polish publisher (e.g. Fabryka Słów for 'Kroniki Mroku'/King's Dark "
    "Tidings), lubimyczytac.pl, empik.com, taniaksiazka.pl. Read Polish dates "
    "('premiera: 15 stycznia 2026').\n"
    "- en: search the author's own site, Goodreads and Amazon.\n"
    "Do NOT search the other language's sources when it was not requested.\n\n"
    "Use the two tools:\n"
    "- web_search(query): run focused queries for the requested language(s).\n"
    "- fetch_url(url): open the most official result (publisher/author page first) and read "
    "it to confirm a real book title and a date.\n\n"
    "HARD RULES:\n"
    "- NEVER invent or guess a date.\n"
    "- Report the REAL book title of the next volume, not the series name.\n"
    "- Always note the source URL you took each fact from.\n"
    "- Keep tool calls minimal; you have a strict call budget.\n"
    "When done, write a short plain-text brief of what you found for each requested "
    "language: the next volume's real title, its volume number, any release/announcement "
    "date (or that none was found), whether it is released / announced / being translated / "
    "no news, and the source URL for each fact."
)

_EDITOR_PROMPT = (
    "You are an editor. Turn the researcher's brief into ONE clean, facts-only release "
    "summary, in the style of Google's AI answer. You MUST NOT invent anything: use only "
    "what the brief states.\n\n"
    "Produce a ReleaseSummary with:\n"
    "- status: one of released, announced, in_translation, no_news, unknown.\n"
    "- headline: EXACTLY ONE factual sentence in POLISH, e.g. 'Fabryka Słów nie podała "
    "jeszcze daty premiery 7. tomu (Ritual of Ruin); tłumaczenie trwa, premiera nie "
    "wcześniej niż w 2026.'\n"
    "- next_title: the REAL book title only (e.g. 'Ritual of Ruin'). NEVER a series-tagged "
    'string like "King\'s Dark Tidings (Kroniki mroku tom 7)". If you only know the series '
    "name and no real book title, leave next_title null.\n"
    "- next_volume: the volume number (a number), or null.\n"
    "- expected_date: free text ('2026', 'początek 2026') or an ISO date, or null. Never "
    "invent one.\n"
    "- details: a few SHORT Polish bullets of FACTS found on a page, each with the "
    "source_url it came from. Never write bullets about what you did not find or did not "
    "check (no 'Nie znaleziono…', 'Nie sprawdzono…').\n"
    "- editions: per requested language ('pl' and/or 'en') with status, title, date, "
    "source_url.\n"
    "If the brief found nothing concrete, use status 'no_news' or 'unknown', a factual "
    "Polish headline saying so, and null title/date. Return ONLY the structured summary."
)


def _next_number(owned: list[float]) -> int | None:
    whole = [int(v) for v in owned if float(v).is_integer()]
    return (max(whole) + 1) if whole else None


def seed_queries(
    series: str, author: str, owned: list[float], aliases: list[str], langs: list[str]
) -> list[str]:
    """One or two seed searches (per requested language) so the researcher starts well.

    pl: ``<Polish name> tom <n> <author> premiera`` (Polish name = first alias differing
    from the main name, else the main name). en: ``<author> <series> book <n> release date``.
    """
    n = _next_number(owned)
    num = f" {n}" if n else ""
    pl_name = next((a for a in aliases if a and a.strip().lower() != series.lower()), series)
    who = f"{author} " if author else ""
    out: list[str] = []
    if "pl" in langs:
        out.append(f"{pl_name} tom{num} {author} premiera".strip())
    if "en" in langs:
        out.append(f"{who}{series} book{num} release date".strip())
    return out


def _format_leads(leads: list[tuple[str, list[dict[str, str]]]]) -> str:
    lines: list[str] = []
    for query, results in leads:
        lines.append(f"Search: {query}")
        if not results:
            lines.append("  (no results)")
        for r in results[:6]:
            snippet = (r.get("snippet") or "")[:160]
            lines.append(f"  - {r.get('title', '')} | {r.get('url', '')} | {snippet}")
    return "\n".join(lines)


def _build_prompt(
    series: str,
    author: str,
    owned: list[float],
    langs: list[str],
    aliases: list[str] | None = None,
    leads: str = "",
) -> str:
    owned_sorted = sorted({int(v) if float(v).is_integer() else v for v in owned})
    highest = max(owned_sorted) if owned_sorted else "unknown"
    owned_str = ", ".join(str(v) for v in owned_sorted) if owned_sorted else "none recorded"
    other = ", ".join(a for a in (aliases or []) if a) or "none"
    nxt = _next_number(owned)
    lang_label = {"pl": "Polish", "en": "original/English"}
    langs_str = ", ".join(lang_label.get(language, language) for language in langs)
    text = (
        f"Series: {series}\n"
        f"Other names (other languages/editions): {other}\n"
        f"Author: {author or 'unknown'}\n"
        f"Owned volume numbers: {owned_str}\n"
        f"Highest owned: {highest}\n"
        f"Next volume to find: {nxt if nxt else 'unknown'}\n"
        f"LANGUAGE(S) to search (ONLY these): {langs_str}\n\n"
        "Find the next volume after the highest owned one, in the requested language(s) "
        "only. The Polish edition is usually listed under one of the other names above. "
        "Report the real book title, the volume number, any date (or that none exists), the "
        "status, and the source URL for each fact."
    )
    if leads:
        text += (
            "\n\nStarting leads (already searched for you; fetch_url the most official one "
            "to read the real title and date):\n" + leads
        )
    return text


def _build_model(settings: Settings) -> Model:
    """Build the Bedrock model (same env wiring as the chat engine / enrichment)."""
    from strands_compose.models import create_model

    os.environ.setdefault("BEDROCK_MODEL_ID", settings.bedrock_model_id)
    os.environ.setdefault("AWS_REGION", settings.aws_region)
    return create_model(
        "bedrock",
        settings.bedrock_model_id,
        region_name=settings.aws_region,
        max_tokens=2048,
    )


def _make_tools(budget: CallBudget) -> list[Any]:
    """Build the two web tools bound to one run's shared call budget."""
    from strands import tool

    @tool
    def web_search(query: str) -> list[dict[str, str]]:
        """Search the web (DuckDuckGo) and return up to 8 results.

        Args:
            query: The search query. Be specific (series title + publisher/author + 'tom'
                or volume number + edition language).
        """
        return web_research.web_search(query, budget=budget)

    @tool
    def fetch_url(url: str) -> str:
        """Fetch one web page and return its readable text (capped at ~6000 chars).

        Args:
            url: An http(s) URL from a web_search result worth reading in full.
        """
        return web_research.fetch_url(url, budget=budget)

    return [web_search, fetch_url]


def _clean_title(title: str | None, series: str, aliases: list[str]) -> str | None:
    """Reject a mangled title that is really just the series name (+ volume tag).

    The editor is told to return the REAL book title; this is a defensive net so a value
    like "King's Dark Tidings (Kroniki mroku tom 7)" or the bare series name never reaches
    the waiting list or the library.
    """
    if not title:
        return None
    t = title.strip()
    if not t:
        return None
    from app.services.series import series_key

    folded = series_key(t)
    series_keys = {series_key(series), *(series_key(a) for a in aliases if a)}
    series_keys.discard("")
    # Bare series name, or series name with a trailing volume tag in parentheses.
    if folded in series_keys:
        return None
    for sk in series_keys:
        # "<series> tom 7", "<series> (… tom 7)", "<series> vol 7" all fold to start with sk.
        if (
            sk
            and folded.startswith(sk)
            and any(
                w in folded[len(sk) :] for w in ("tom", "vol", "book", "ksiega", "czesc", "etap")
            )
        ):
            return None
    return t


def _clamp_summary(summary: ReleaseSummary, series: str, aliases: list[str]) -> ReleaseSummary:
    """Clamp the editor output: valid status, no invented date, clean title."""
    if summary.status not in _STATUS_VALUES:
        summary.status = "unknown"
    summary.next_title = _clean_title(summary.next_title, series, aliases)
    # No title => no standalone date for the next book (status may still describe the series).
    if summary.next_title is None and summary.status in ("unknown", "no_news"):
        summary.expected_date = None
    # Details are facts with a source; drop source-less filler ("nothing found", "not checked").
    summary.details = [d for d in summary.details if d.source_url and d.text.strip()]
    # Clean each edition's title the same way.
    for edition in summary.editions.values():
        if edition.status is not None and edition.status not in _STATUS_VALUES:
            edition.status = "unknown"
        edition.title = _clean_title(edition.title, series, aliases)
    return summary


def _edition_result(summary: ReleaseSummary, lang: str) -> EditionResult:
    """Project the clean summary into the legacy per-edition row for next_expected_*."""
    ed = summary.editions.get(lang)
    if ed is not None and (ed.title or ed.date):
        status = ed.status or summary.status
        return EditionResult(
            title=_clean_title(ed.title, "", []) or ed.title,
            date=ed.date,
            status=status if status in ("announced", "released", "in_translation") else "unknown",
            source_url=ed.source_url,
            confidence=None,
        )
    return EditionResult(status="unknown")


async def research_next_volumes(
    series: str,
    author: str,
    owned_volumes: list[float],
    *,
    search_lang: str = "pl",
    settings: Settings | None = None,
    model: Model | None = None,
    budget: CallBudget | None = None,
    aliases: list[str] | None = None,
) -> ResearchResult:
    """Research the next volume for a series on the web in the requested language(s).

    Runs a RESEARCHER agent (web tools) then an EDITOR agent (strict :class:`ReleaseSummary`).
    Returns a :class:`ResearchResult`; on any failure it returns an all-``unknown`` result
    rather than raising, so a watch-on / refresh never fails because research did. Tests
    inject a fake ``model`` (and may pre-seed the web cache) to run without AWS or network.
    """
    from strands import Agent

    settings = settings or get_settings()
    budget = budget or CallBudget(settings.web_research_max_calls)
    series = (series or "").strip()
    aliases = aliases or []
    langs = _langs(search_lang)
    if not series:
        return ResearchResult()

    try:
        chat_model = model or _build_model(settings)
        # Phase 1: RESEARCHER runs the web tools and writes a plain-text brief.
        researcher = Agent(
            model=chat_model,
            system_prompt=_RESEARCHER_PROMPT,
            tools=_make_tools(budget),
            callback_handler=None,
        )
        leads = [
            (q, web_research.web_search(q, budget=budget))
            for q in seed_queries(series, author, owned_volumes, aliases, langs)
        ]
        brief = await researcher.invoke_async(
            _build_prompt(series, author, owned_volumes, langs, aliases, _format_leads(leads))
        )
        # Phase 2: EDITOR distils the brief into the strict ReleaseSummary (no tools).
        editor = Agent(
            model=chat_model,
            system_prompt=_EDITOR_PROMPT,
            callback_handler=None,
        )
        summary = await editor.structured_output_async(
            ReleaseSummary,
            "Researcher's brief:\n\n"
            f"{brief}\n\n"
            "Write the single clean release summary now. Only use facts from the brief.",
        )
    except Exception:  # noqa: BLE001 - best-effort; any failure yields all-unknown
        logger.warning("release research failed for %r", series, exc_info=True)
        return ResearchResult()

    summary = _clamp_summary(summary, series, aliases)
    from datetime import datetime, timezone

    summary.checked_at = datetime.now(timezone.utc).isoformat()
    return ResearchResult(
        summary=summary,
        pl=_edition_result(summary, "pl"),
        en=_edition_result(summary, "en"),
    )
