"""Pydantic v2 request/response models for books."""

from __future__ import annotations

from datetime import date
from enum import Enum

from pydantic import BaseModel, Field, field_validator


def _validate_half_step(value: float | None) -> float | None:
    """Stars must be a multiple of 0.5 (0.5, 1.0, 1.5 ... 5.0). ``None`` means unrated."""
    if value is None:
        return value
    if round(value * 2) != value * 2:
        raise ValueError("stars must be given in half-star steps (0.5, 1.0, ... 5.0)")
    return value


class ReadingStatus(str, Enum):
    want = "want"
    reading = "reading"
    finished = "finished"
    abandoned = "abandoned"


class VolumeSearchResult(BaseModel):
    """A metadata hit from Google Books / OpenLibrary, not yet in the library."""

    google_volume_id: str | None = None
    title: str
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    publisher: str | None = None
    published_date: str | None = None
    description: str | None = None
    page_count: int | None = None
    categories: list[str] = Field(default_factory=list)
    language: str | None = None
    isbn_10: str | None = None
    isbn_13: str | None = None
    cover_url: str | None = None


class SearchResponse(BaseModel):
    total_items: int
    items: list[VolumeSearchResult]


class BookFields(BaseModel):
    """Everything the user owns about a book: catalogue metadata plus reading data."""

    external_id: str | None = None
    google_volume_id: str | None = None
    title: str = Field(min_length=1, max_length=500)
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    translators: list[str] = Field(default_factory=list)
    publisher: str | None = None
    published_date: str | None = None
    description: str | None = None
    page_count: int | None = Field(default=None, ge=0)
    categories: list[str] = Field(default_factory=list)
    language: str | None = None
    isbn_10: str | None = None
    isbn_13: str | None = None
    cover_url: str | None = None
    format: str | None = None
    edition: str | None = None
    series: str | None = None
    volume: str | None = None
    status: ReadingStatus = ReadingStatus.want
    stars: float | None = Field(default=None, ge=0.5, le=5)
    started_on: date | None = None
    finished_on: date | None = None
    pages_read: int | None = Field(default=None, ge=0)
    shelves: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    review: str | None = None
    notes: str | None = None
    quotes: str | None = None
    signed: bool = False
    condition: str | None = None
    copies: int = Field(default=1, ge=0)
    purchase_date: date | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    purchase_from: str | None = None
    metadata_source: str = "manual"

    @field_validator("authors", "translators", "categories", "shelves", "tags", mode="before")
    @classmethod
    def none_to_list(cls, value: object) -> object:
        return [] if value is None else value

    @field_validator("stars")
    @classmethod
    def stars_half_step(cls, value: float | None) -> float | None:
        return _validate_half_step(value)

    @field_validator("started_on", "finished_on", "purchase_date", mode="before")
    @classmethod
    def blank_date_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class BookCreate(BookFields):
    """Add a book — from a search hit, from the dataset, or typed in by hand."""


class BookUpdate(BaseModel):
    """Partial update: only the fields that are sent are changed."""

    google_volume_id: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    subtitle: str | None = None
    authors: list[str] | None = None
    translators: list[str] | None = None
    publisher: str | None = None
    published_date: str | None = None
    description: str | None = None
    page_count: int | None = Field(default=None, ge=0)
    categories: list[str] | None = None
    language: str | None = None
    isbn_10: str | None = None
    isbn_13: str | None = None
    cover_url: str | None = None
    format: str | None = None
    edition: str | None = None
    series: str | None = None
    volume: str | None = None
    status: ReadingStatus | None = None
    stars: float | None = Field(default=None, ge=0.5, le=5)
    started_on: date | None = None
    finished_on: date | None = None
    pages_read: int | None = Field(default=None, ge=0)
    shelves: list[str] | None = None
    tags: list[str] | None = None
    review: str | None = None
    notes: str | None = None
    quotes: str | None = None
    signed: bool | None = None
    condition: str | None = None
    copies: int | None = Field(default=None, ge=0)
    purchase_date: date | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    purchase_from: str | None = None

    @field_validator("stars")
    @classmethod
    def stars_half_step(cls, value: float | None) -> float | None:
        return _validate_half_step(value)

    @field_validator("started_on", "finished_on", "purchase_date", mode="before")
    @classmethod
    def blank_date_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value


class Book(BookFields):
    id: int
    latent_strength: float | None = None
    rating_uncertainty: float | None = None
    display_score: float | None = None
    comparison_count: int = 0
    added_at: str
    updated_at: str
