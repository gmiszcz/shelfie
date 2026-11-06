"""Pydantic v2 request/response models."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class ReadingStatus(str, Enum):
    want = "want"
    reading = "reading"
    finished = "finished"
    abandoned = "abandoned"


class BookBase(BaseModel):
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


class Book(BookBase):
    id: int
    status: ReadingStatus = ReadingStatus.want
    stars: float | None = None
    added_at: str
    updated_at: str


class BookCreate(BookBase):
    """Add a book to the library, either from a Google Books volume or by hand."""

    status: ReadingStatus = ReadingStatus.want
    stars: float | None = Field(default=None, ge=1, le=5)


class BookUpdate(BaseModel):
    status: ReadingStatus | None = None
    stars: float | None = Field(default=None, ge=1, le=5)


class VolumeSearchResult(BookBase):
    """A Google Books search hit, not yet persisted."""


class SearchResponse(BaseModel):
    total_items: int
    items: list[VolumeSearchResult]
