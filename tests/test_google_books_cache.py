"""Tests for the Google Books client cache, per-process call budget and 429 handling.

All network is mocked via httpx.MockTransport — no live Google Books call is ever made.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from app.integrations import google_books as gb
from app.integrations.google_books import GoogleBooksBudgetExceeded, GoogleBooksClient


@pytest.fixture(autouse=True)
def _reset_budget():
    gb._reset_call_count()
    yield
    gb._reset_call_count()


def _volumes_payload(title: str) -> dict:
    return {"totalItems": 1, "items": [{"id": "v1", "volumeInfo": {"title": title}}]}


def _client(transport: httpx.MockTransport, tmp_path: Path, **kw) -> GoogleBooksClient:
    http = httpx.AsyncClient(transport=transport)
    return GoogleBooksClient(
        base_url="https://books.test/v1",
        api_key="secret-key",
        client=http,
        cache_dir=tmp_path / "cache",
        cache_ttl_days=30,
        max_calls=kw.get("max_calls", 50),
    )


async def test_cache_miss_then_hit_makes_one_network_call(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        assert request.url.params.get("key") == "secret-key"
        return httpx.Response(200, json=_volumes_payload("Dune"))

    transport = httpx.MockTransport(handler)
    client = _client(transport, tmp_path)

    total1, items1 = await client.search("dune", lang="en")
    total2, items2 = await client.search("dune", lang="en")

    assert calls["n"] == 1  # second call served from cache
    assert gb.live_call_count() == 1
    assert total1 == total2 == 1
    assert items1[0].title == items2[0].title == "Dune"

    # The cached file must not contain the API key.
    cache_files = list((tmp_path / "cache").glob("*.json"))
    assert len(cache_files) == 1
    assert "secret-key" not in cache_files[0].read_text(encoding="utf-8")


async def test_budget_refuses_after_max_calls(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_volumes_payload(str(request.url)))

    transport = httpx.MockTransport(handler)
    client = _client(transport, tmp_path, max_calls=2)

    await client.search("q1")
    await client.search("q2")
    with pytest.raises(GoogleBooksBudgetExceeded):
        await client.search("q3")


async def test_stop_on_429_no_retry(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, text="Queries per day")

    transport = httpx.MockTransport(handler)
    client = _client(transport, tmp_path)

    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.search("quota-test")
    assert exc.value.response.status_code == 429
    assert calls["n"] == 1  # no retries


async def test_expired_cache_entry_is_ignored(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=_volumes_payload("Fresh"))

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    # TTL 0 days -> every entry is already expired, so each call hits the network.
    client = GoogleBooksClient(
        base_url="https://books.test/v1",
        api_key="k",
        client=http,
        cache_dir=tmp_path / "cache",
        cache_ttl_days=0,
        max_calls=50,
    )
    await client.search("x")
    await client.search("x")
    assert calls["n"] == 2
