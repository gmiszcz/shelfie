"""Book API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _sample_payload() -> dict:
    return {
        "google_volume_id": "vol-1",
        "title": "The Name of the Wind",
        "authors": ["Patrick Rothfuss"],
        "status": "want",
    }


def test_health(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_library_starts_empty(client: TestClient) -> None:
    resp = client.get("/api/books")
    assert resp.status_code == 200
    assert resp.json() == []


def test_add_and_list_book(client: TestClient) -> None:
    resp = client.post("/api/books", json=_sample_payload())
    assert resp.status_code == 201
    created = resp.json()
    assert created["title"] == "The Name of the Wind"
    assert created["authors"] == ["Patrick Rothfuss"]
    assert created["status"] == "want"

    listed = client.get("/api/books").json()
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]


def test_duplicate_volume_is_conflict(client: TestClient) -> None:
    assert client.post("/api/books", json=_sample_payload()).status_code == 201
    resp = client.post("/api/books", json=_sample_payload())
    assert resp.status_code == 409


def test_update_status_and_rating(client: TestClient) -> None:
    book_id = client.post("/api/books", json=_sample_payload()).json()["id"]
    resp = client.patch(f"/api/books/{book_id}", json={"status": "finished", "stars": 5})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "finished"
    assert body["stars"] == 5


def test_rating_out_of_range_rejected(client: TestClient) -> None:
    book_id = client.post("/api/books", json=_sample_payload()).json()["id"]
    assert client.patch(f"/api/books/{book_id}", json={"stars": 6}).status_code == 422


def test_get_missing_book_404(client: TestClient) -> None:
    assert client.get("/api/books/999").status_code == 404


def test_delete_book(client: TestClient) -> None:
    book_id = client.post("/api/books", json=_sample_payload()).json()["id"]
    assert client.delete(f"/api/books/{book_id}").status_code == 204
    assert client.get(f"/api/books/{book_id}").status_code == 404
