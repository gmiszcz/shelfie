"""Release-research step: find a series' next volume on the open web (wave 5).

A small strands agent on Bedrock (the same Haiku model and env wiring as the chat engine
and the enrichment step) is given a series, its author and the volumes the user owns, and
asked to find the NEXT volume after the highest owned one — separately for the Polish
edition and the original/English edition. It has exactly two tools, both web-only and
**never Google Books**:

* ``web_search(query)`` — DuckDuckGo HTML results (title/url/snippet).
* ``fetch_url(url)`` — one page's readable text (capped).

Both are disk-cached (7-day TTL) and share a per-run :class:`CallBudget` (default 12 live
calls), so a single research run is bounded. The agent returns strict JSON
``{pl:{...}, en:{...}}`` where each side is ``{title, date, status, source_url,
confidence}``; ``status`` is one of ``announced`` / ``released`` / ``unknown``. The model
is told to NEVER invent a date: when it cannot find one it must return ``unknown`` with a
null date. Any model/transport/validation error yields an empty (all-unknown) result so
watch-on never fails because research did.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.integrations import web_research
from app.integrations.web_research import CallBudget

if TYPE_CHECKING:
    from strands.models.model import Model

logger = logging.getLogger(__name__)


class EditionResult(BaseModel):
    """One edition's next-volume finding. Never fabricated: unknown when not found."""

    title: str | None = None
    date: str | None = None
    status: str = "unknown"  # "announced" | "released" | "unknown"
    source_url: str | None = None
    confidence: str | None = None  # "high" | "medium" | "low"


class ResearchResult(BaseModel):
    """The full result: the Polish edition and the original/English edition."""

    pl: EditionResult = Field(default_factory=EditionResult)
    en: EditionResult = Field(default_factory=EditionResult)


_SYSTEM_PROMPT = (
    "You research book-series release information on the open web. You are given a series, "
    "its author, and the volume numbers the user already owns. Find the NEXT volume AFTER the "
    "highest owned number — once for the POLISH edition and once for the ORIGINAL/ENGLISH "
    "edition. They can differ: the Polish translation often lags the original.\n\n"
    "Use the two tools:\n"
    "- web_search(query): run focused queries. For the Polish edition search the Polish "
    "publisher and Polish book sites (lubimyczytac.pl, empik.com, taniaksiazka.pl, the "
    "publisher's own site; e.g. Wydawnictwo SQN publishes 'Kroniki Mroku'). For the original "
    "edition search the author's site, Goodreads, Amazon.\n"
    "- fetch_url(url): open a promising result and read it to confirm a title/date.\n\n"
    "HARD RULES:\n"
    "- NEVER invent or guess a date. If you cannot find a concrete release/announcement date "
    "for an edition, return status 'unknown' and date null for that edition.\n"
    "- status is 'released' if the volume is already out, 'announced' if a future date/plan is "
    "stated, otherwise 'unknown'.\n"
    "- Always include the source_url you took a title/date from.\n"
    "- confidence: 'high' if a publisher/author page states it, 'medium' for a retailer/"
    "aggregator, 'low' if inferred from weak evidence.\n"
    "- Keep tool calls minimal; you have a strict call budget.\n"
    "Return ONLY the structured result for both editions (pl and en)."
)


def _build_prompt(series: str, author: str, owned: list[float]) -> str:
    owned_sorted = sorted({int(v) if float(v).is_integer() else v for v in owned})
    highest = max(owned_sorted) if owned_sorted else "unknown"
    owned_str = ", ".join(str(v) for v in owned_sorted) if owned_sorted else "none recorded"
    return (
        f"Series: {series}\n"
        f"Author: {author or 'unknown'}\n"
        f"Owned volume numbers: {owned_str}\n"
        f"Highest owned: {highest}\n\n"
        "Find the next volume after the highest owned one for BOTH the Polish edition and the "
        "original/English edition. Return pl and en, each with title, date, status, source_url, "
        "confidence. Use 'unknown' with a null date where you cannot find a concrete date."
    )


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


async def research_next_volumes(
    series: str,
    author: str,
    owned_volumes: list[float],
    *,
    settings: Settings | None = None,
    model: Model | None = None,
    budget: CallBudget | None = None,
) -> ResearchResult:
    """Research the next PL and EN volumes for a series on the web.

    Returns a :class:`ResearchResult`; on any failure it returns an all-``unknown`` result
    rather than raising, so a watch-on / refresh never fails because research did. Tests
    inject a fake ``model`` (and may pre-seed the web cache) to run without AWS or network.
    """
    from strands import Agent

    settings = settings or get_settings()
    budget = budget or CallBudget(settings.web_research_max_calls)
    series = (series or "").strip()
    if not series:
        return ResearchResult()

    try:
        chat_model = model or _build_model(settings)
        agent = Agent(
            model=chat_model,
            system_prompt=_SYSTEM_PROMPT,
            tools=_make_tools(budget),
            callback_handler=None,
        )
        # Phase 1: let the model actually USE the web tools. structured_output alone does
        # not run the tool loop, so we first run a normal turn where it searches/fetches,
        # then (phase 2) ask it to distil the conversation into the strict schema.
        await agent.invoke_async(_build_prompt(series, author, owned_volumes))
        result = await agent.structured_output_async(
            ResearchResult,
            "From everything you found above, return the next volume for the Polish edition "
            "(pl) and the original/English edition (en). Use 'unknown' with a null date where "
            "you found no concrete date. Never invent a date.",
        )
    except Exception:  # noqa: BLE001 - best-effort; any failure yields all-unknown
        logger.warning("release research failed for %r", series, exc_info=True)
        return ResearchResult()

    # Defensive: never let a date survive without a status, and clamp status to the set.
    for edition in (result.pl, result.en):
        if edition.status not in ("announced", "released", "unknown"):
            edition.status = "unknown"
        if edition.status == "unknown":
            edition.date = None
    return result
