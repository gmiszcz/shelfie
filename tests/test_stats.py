"""Reading statistics API tests."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

BOOKS: list[dict[str, Any]] = [
    {
        "title": "A",
        "finished_on": "2025-03-10",
        "shelves": ["Fantasy"],
        "tags": ["Magia"],
        "page_count": 300,
    },
    {
        "title": "B",
        "finished_on": "2025-03-20",
        "shelves": ["Fantasy"],
        "tags": ["Magia", "Runy"],
        "page_count": 200,
    },
    {
        "title": "C",
        "finished_on": "2026-01-05",
        "shelves": ["Thriller"],
        "tags": [],
        "page_count": 100,
    },
    {"title": "D", "status": "reading", "started_on": "2026-02-01", "shelves": ["Fantasy"]},
]


def _seed(client: TestClient) -> None:
    for i, book in enumerate(BOOKS):
        body = {"status": "finished", "google_volume_id": f"v{i}", **book}
        assert client.post("/api/books", json=body).status_code == 201


def test_group_by_year_counts_only_finished(client: TestClient) -> None:
    _seed(client)
    body = client.get("/api/stats", params={"group_by": "year"}).json()
    assert body["summary"]["books"] == 3
    assert body["summary"]["pages"] == 600
    assert body["buckets"] == [
        {"key": "2025", "books": 2, "pages": 500},
        {"key": "2026", "books": 1, "pages": 100},
    ]


def test_group_by_shelf_and_tag(client: TestClient) -> None:
    _seed(client)
    shelves = client.get("/api/stats", params={"group_by": "shelf"}).json()["buckets"]
    assert shelves[0] == {"key": "Fantasy", "books": 2, "pages": 500}
    tags = {
        b["key"]: b["books"]
        for b in client.get("/api/stats", params={"group_by": "tag"}).json()["buckets"]
    }
    assert tags == {"Magia": 2, "Runy": 1, "—": 1}


def test_date_range_filter_and_month_grouping(client: TestClient) -> None:
    _seed(client)
    body = client.get(
        "/api/stats",
        params={"group_by": "month", "date_from": "2025-03-15", "date_to": "2025-12-31"},
    ).json()
    assert [b["title"] for b in body["books"]] == ["B"]
    assert body["buckets"] == [{"key": "2025-03", "books": 1, "pages": 200}]


def test_inverted_range_is_rejected(client: TestClient) -> None:
    resp = client.get("/api/stats", params={"date_from": "2026-01-01", "date_to": "2025-01-01"})
    assert resp.status_code == 422
