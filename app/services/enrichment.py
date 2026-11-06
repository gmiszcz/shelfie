"""Generate structured ``insights`` for a book with a cheap Bedrock model.

The enrichment model is given one book's catalogue metadata (title, authors, description,
series) and asked for a small, strictly-typed set of insights *in the book's own language*.
It is told to answer ``null`` for anything it is not sure about rather than invent, and the
result is parsed through a strict Pydantic schema. Any model, transport or validation error
leaves the book's insights ``null`` — enrichment is best-effort and never blocks a write.

The Bedrock model is built the same way ``app/agent/engine.py`` builds the chat model: the
model id and region come from :class:`app.config.Settings`, and credentials come from the
standard AWS chain.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import BaseModel, ValidationError

from app.config import Settings, get_settings
from app.schemas.books import BookInsights

if TYPE_CHECKING:
    from strands.models.model import Model

    from app.schemas.books import Book, BookCreate

logger = logging.getLogger(__name__)

# A language tag (ISO 639-1, or a close variant) -> the name the model should write in.
_LANGUAGE_NAMES: dict[str, str] = {
    "pl": "Polish",
    "en": "English",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "ru": "Russian",
    "uk": "Ukrainian",
    "cs": "Czech",
    "pt": "Portuguese",
    "nl": "Dutch",
    "sv": "Swedish",
}


class _GeneratedInsights(BaseModel):
    """What we ask the model to fill. Narrow, nullable, no metadata fields."""

    summary: str | None = None
    main_characters: str | None = None
    main_plot: str | None = None
    setting: str | None = None
    themes: str | None = None
    tone: str | None = None


def language_name(code: str | None) -> str:
    """Human-readable language name for a book's ``language`` code, defaulting to English."""
    if not code:
        return "English"
    return _LANGUAGE_NAMES.get(code.strip().lower()[:2], "English")


_SYSTEM_PROMPT = (
    "You are a literary cataloguer. From the metadata of a single book you produce a small set "
    "of factual insights. You MUST follow these rules:\n"
    "- Write every field in {language}. Do not translate proper nouns that have no {language} "
    "form.\n"
    "- Base every answer ONLY on the information given. Never invent characters, places, plot "
    "points, authors or facts.\n"
    "- If you are not confident about a field from the given information, set it to null. A null "
    "is always better than a guess.\n"
    "- Keep each field to one or two sentences; 'main_characters' is a short comma-separated list "
    "of names/roles.\n"
    "Fields: summary (what the book is about), main_characters, main_plot, setting (time/place), "
    "themes, tone (mood/style)."
)


def _build_prompt(
    *,
    title: str,
    authors: list[str],
    description: str | None,
    series: str | None,
    volume: str | None,
) -> str:
    lines = [f"Title: {title}"]
    if authors:
        lines.append(f"Authors: {', '.join(authors)}")
    if series:
        series_line = series if not volume else f"{series} (volume {volume})"
        lines.append(f"Series: {series_line}")
    if description and description.strip():
        lines.append(f"Description:\n{description.strip()}")
    else:
        lines.append(
            "Description: (none provided — only fill fields you can be confident about, "
            "otherwise null)"
        )
    return "\n".join(lines)


def _build_model(settings: Settings) -> Model:
    """Build the Bedrock chat model from settings (same env wiring as the chat engine)."""
    from strands_compose.models import create_model

    os.environ.setdefault("BEDROCK_MODEL_ID", settings.bedrock_model_id)
    os.environ.setdefault("AWS_REGION", settings.aws_region)
    return create_model(
        "bedrock",
        settings.bedrock_model_id,
        region_name=settings.aws_region,
        max_tokens=1024,
    )


async def generate_insights(
    book: Book | BookCreate,
    *,
    settings: Settings | None = None,
    model: Model | None = None,
) -> BookInsights | None:
    """Generate insights for one book, or ``None`` on any failure.

    Args:
        book: The book to enrich; its title, authors, description and series are used.
        settings: Overrides the process settings (tests inject a stub-backed ``Settings``).
        model: An already-built strands model (tests inject a fake); built from settings
            when omitted.

    Returns:
        A validated :class:`BookInsights` with ``source="agent"`` and a UTC ``generated_at``
        timestamp, or ``None`` when the model call or parsing failed.
    """
    from strands import Agent

    settings = settings or get_settings()
    title = (book.title or "").strip()
    if not title:
        return None

    lang = language_name(book.language)
    try:
        chat_model = model or _build_model(settings)
        agent = Agent(
            model=chat_model,
            system_prompt=_SYSTEM_PROMPT.format(language=lang),
            callback_handler=None,
        )
        prompt = _build_prompt(
            title=title,
            authors=list(book.authors or []),
            description=book.description,
            series=book.series,
            volume=book.volume,
        )
        generated = await agent.structured_output_async(_GeneratedInsights, prompt)
    except ValidationError:
        logger.warning("enrichment: model output failed validation for %r", title)
        return None
    except Exception:  # noqa: BLE001 - best-effort; any failure leaves insights null
        logger.warning("enrichment: generation failed for %r", title, exc_info=True)
        return None

    return BookInsights(
        **generated.model_dump(),
        generated_at=datetime.now(timezone.utc).isoformat(),
        source="agent",
    )
