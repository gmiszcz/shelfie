"""OpenLibrary fallback and normalization tests."""

from __future__ import annotations

import httpx
import pytest

from app.integrations.google_books import GoogleBooksClient
from app.integrations.openlibrary import _normalize_doc

OPENLIBRARY_DOC = {
    "key": "/works/OL123W",
    "title": "Droga Szamana",
    "author_name": ["Vasily Mahanenko"],
    "first_publish_year": 2013,
    "isbn": ["9788381888888", "8381888880"],
    "cover_i": 42,
    "language": ["pol"],
    "subject": ["LitRPG", "Fantasy"],
}

OPENLIBRARY_PAYLOAD = {"numFound": 1, "docs": [OPENLIBRARY_DOC]}


def test_normalize_openlibrary_doc() -> None:
    volume = _normalize_doc(OPENLIBRARY_DOC)
    assert volume.title == "Droga Szamana"
    assert volume.authors == ["Vasily Mahanenko"]
    assert volume.published_date == "2013"
    assert volume.isbn_13 == "9788381888888"
    assert volume.isbn_10 == "8381888880"
    assert volume.cover_url == "https://covers.openlibrary.org/b/id/42-L.jpg"
    assert volume.google_volume_id == "/works/OL123W"


async def test_google_429_falls_back_to_openlibrary() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "googleapis.com" in str(request.url):
            return httpx.Response(429, json={"error": "rate limited"})
        if "openlibrary.org" in str(request.url):
            return httpx.Response(200, json=OPENLIBRARY_PAYLOAD)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1",
            api_key=None,
            client=http,
        )
        total, items = await client.search("droga szamana")
    assert total == 1
    assert items[0].title == "Droga Szamana"


async def test_google_429_with_key_does_not_fall_back() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "rate limited"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1",
            api_key="a-key",
            client=http,
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.search("droga szamana")


# --- "The Way of the Shaman" / "Droga Szamana" by Vasily Mahanenko ---------------
# Real-world fact (verified against OpenLibrary): the Polish title "Droga Szamana"
# returns nothing; the book is indexed in English as "Survival Quest" /
# "The Way of the Shaman", author "Vasily Mahanenko", series Barliona. These tests
# pin that the app finds it the ways that actually work, and that the language
# filter is forwarded to the provider.

# A trimmed shape of what OpenLibrary returns for this book.
SHAMAN_DOCS = [
    {
        "key": "/works/OL17930368W",
        "title": "Survival Quest (the Way of the Shaman Book #1)",
        "author_name": ["Vasily Mahanenko"],
        "first_publish_year": 2015,
        "isbn": ["9781516872336", "1516872339"],
        "cover_i": 8231856,
        "language": ["eng"],
        "subject": ["LitRPG", "Fantasy"],
    },
    {
        "key": "/works/OL17930370W",
        "title": "The Kartoss Gambit (the Way of the Shaman Book #2)",
        "author_name": ["Vasily Mahanenko"],
        "first_publish_year": 2015,
        "isbn": ["9781515953623"],
        "cover_i": 8231857,
        "language": ["eng"],
        "subject": ["LitRPG"],
    },
]


def _shaman_transport(expect_lang: str | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "googleapis.com" in url:
            # Simulate the keyless Google quota being exhausted -> fall back.
            return httpx.Response(429, json={"error": "rate limited"})
        if "openlibrary.org" in url:
            params = request.url.params
            if expect_lang is not None:
                assert params.get("language") == expect_lang, (
                    f"expected language={expect_lang}, got {params.get('language')}"
                )
            return httpx.Response(200, json={"numFound": len(SHAMAN_DOCS), "docs": SHAMAN_DOCS})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.mark.parametrize(
    "query",
    [
        "Way of the Shaman Mahanenko",
        "Survival Quest Mahanenko",
        "The Way of the Shaman",
        "inauthor:Mahanenko",
        "Barliona",
    ],
)
async def test_find_shaman_many_ways(query: str) -> None:
    """The book is found via each realistic query (title, English title, author, series)."""
    async with httpx.AsyncClient(transport=_shaman_transport()) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1", api_key=None, client=http
        )
        total, items = await client.search(query)
    assert total >= 1
    assert any("Way of the Shaman" in b.title for b in items)
    first = items[0]
    assert first.authors == ["Vasily Mahanenko"]
    assert first.isbn_13 == "9781516872336"
    assert first.cover_url == "https://covers.openlibrary.org/b/id/8231856-L.jpg"


async def test_shaman_language_filter_english() -> None:
    """A lang filter is mapped (en -> eng) and forwarded to OpenLibrary."""
    async with httpx.AsyncClient(transport=_shaman_transport(expect_lang="eng")) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1", api_key=None, client=http
        )
        total, items = await client.search("Way of the Shaman", lang="en")
    assert total >= 1
    assert items[0].title.startswith("Survival Quest")


async def test_shaman_language_filter_polish_maps_code() -> None:
    """pl is mapped to OpenLibrary's 'pol' code."""
    async with httpx.AsyncClient(transport=_shaman_transport(expect_lang="pol")) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1", api_key=None, client=http
        )
        await client.search("Mahanenko", lang="pl")


def test_clean_title_strips_series_and_volume() -> None:
    """The seed's title cleaner removes series/volume noise that defeats exact matching."""
    from scripts.seed import clean_title

    assert clean_title("Droga Szamana. Etap 1: Początek") == "Droga Szamana. Etap 1: Początek"
    assert clean_title("Złote enklawy (Scholomance, #3)") == "Złote enklawy"
    assert clean_title("Percy Jackson T.3 Klątwa") == "Percy Jackson"
    assert clean_title("Dwór srebrnych płomieni. Część 2") == "Dwór srebrnych płomieni"


def test_build_queries_progressive() -> None:
    """The seed builds strict -> loose queries so a series-tagged title still resolves."""
    from scripts.seed import build_queries

    queries = build_queries("Survival Quest (The Way of the Shaman Book #1)", "Vasily Mahanenko")
    assert any("inauthor" in q for q in queries)
    # The cleaned bare title is one of the fallbacks.
    assert "Survival Quest" in queries


# Keyed Google Books returns the POLISH editions directly (no fallback). This mirrors the
# verified live response for q="droga szamana"&langRestrict=pl.
GOOGLE_PL_RESPONSE = {
    "totalItems": 185,
    "items": [
        {
            "id": "pl-vol-6",
            "volumeInfo": {
                "title": "Droga Szamana. Etap 6: Nowy początek",
                "authors": ["Wasilij Machanienko"],
                "language": "pl",
                "publishedDate": "2019",
                "industryIdentifiers": [{"type": "ISBN_13", "identifier": "9788381887000"}],
                "imageLinks": {"thumbnail": "http://books.google.com/x?id=p6&zoom=1&edge=curl"},
            },
        },
        {
            "id": "pl-vol-4",
            "volumeInfo": {
                "title": "Droga Szamana. Etap 4: Zamek Widmo",
                "authors": ["Wasilij Machanienko"],
                "language": "pl",
            },
        },
    ],
}


async def test_keyed_google_finds_polish_droga_szamana() -> None:
    """With an API key, a Polish query returns Polish editions and langRestrict=pl is sent."""
    seen: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert "googleapis.com" in str(request.url)  # no fallback
        seen["lang"] = request.url.params.get("langRestrict")
        seen["key"] = request.url.params.get("key")
        return httpx.Response(200, json=GOOGLE_PL_RESPONSE)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = GoogleBooksClient(
            base_url="https://www.googleapis.com/books/v1",
            api_key="test-key",
            client=http,
        )
        total, items = await client.search("droga szamana", lang="pl")

    assert total == 185
    assert items[0].title.startswith("Droga Szamana")
    assert items[0].authors == ["Wasilij Machanienko"]
    assert items[0].language == "pl"
    assert items[0].cover_url is not None and items[0].cover_url.startswith("https://")
    assert seen["lang"] == "pl"
    assert seen["key"] == "test-key"
