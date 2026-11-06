"""Rating engine (Bradley-Terry MVP) and ratings API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services import rating


def test_no_comparisons_keeps_star_rating() -> None:
    scores = rating.fit({1: 5.0, 2: 4.0, 3: 3.0}, [])
    assert [scores[i].display for i in (1, 2, 3)] == [5.0, 4.0, 3.0]


def test_winner_rises_above_equal_star_peer() -> None:
    scores = rating.fit({1: 5.0, 2: 5.0}, [(1, 2, "left"), (1, 2, "left")])
    assert scores[1].latent > scores[2].latent
    assert scores[1].display >= scores[2].display
    assert scores[2].display < 5.0  # the loser is refined below a flat 5.0


def test_display_stays_within_half_a_star() -> None:
    comparisons = [(1, 2, "left")] * 30
    scores = rating.fit({1: 3.0, 2: 5.0}, comparisons)
    assert 2.5 <= scores[1].display <= 3.5
    assert 4.5 <= scores[2].display <= 5.0


def test_ties_and_unknown_books_are_handled() -> None:
    scores = rating.fit({1: 4.0, 2: 4.0}, [(1, 2, "tie"), (1, 99, "left")])
    assert abs(scores[1].latent - scores[2].latent) < 1e-6
    assert scores[1].comparisons == 1


def test_uncertainty_shrinks_with_comparisons() -> None:
    before = rating.fit({1: 4.0, 2: 4.0}, [])
    after = rating.fit({1: 4.0, 2: 4.0}, [(1, 2, "left"), (2, 1, "left")] * 5)
    assert after[1].uncertainty < before[1].uncertainty


def test_next_pair_prefers_close_strengths_and_respects_focus() -> None:
    scores = rating.fit({1: 5.0, 2: 5.0, 3: 2.0}, [])
    assert rating.next_pair(scores) == (1, 2)
    focused = rating.next_pair(scores, focus=3)
    assert focused is not None and 3 in focused
    assert rating.next_pair(scores, exclude={(1, 2)}) != (1, 2)


def _add(client: TestClient, title: str, stars: float | None, vol: str) -> int:
    body = {"title": title, "google_volume_id": vol, "stars": stars, "status": "finished"}
    return int(client.post("/api/books", json=body).json()["id"])


def test_pair_needs_two_rated_books(client: TestClient) -> None:
    _add(client, "Only one", 5, "v1")
    assert client.get("/api/ratings/pair").status_code == 204


def test_compare_flow(client: TestClient) -> None:
    a = _add(client, "A", 5, "va")
    b = _add(client, "B", 5, "vb")
    pair = client.get("/api/ratings/pair").json()
    assert {pair["left"]["id"], pair["right"]["id"]} == {a, b}

    resp = client.post("/api/ratings/compare", json={"left_id": a, "right_id": b, "winner": "left"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["left"]["display_score"] >= body["right"]["display_score"]
    assert body["left"]["comparison_count"] == 1

    recompute = client.post("/api/ratings/recompute").json()
    assert recompute == {"rated_books": 2, "comparisons": 1}


def test_compare_rejects_unrated_or_same_book(client: TestClient) -> None:
    a = _add(client, "A", 5, "va")
    unrated = _add(client, "U", None, "vu")
    same = client.post("/api/ratings/compare", json={"left_id": a, "right_id": a, "winner": "left"})
    assert same.status_code == 422
    bad = client.post(
        "/api/ratings/compare", json={"left_id": a, "right_id": unrated, "winner": "left"}
    )
    assert bad.status_code == 422


def test_star_change_recomputes_display_score(client: TestClient) -> None:
    book_id = _add(client, "A", 3, "va")
    assert client.get(f"/api/books/{book_id}").json()["display_score"] == 3.0
    updated = client.patch(f"/api/books/{book_id}", json={"stars": 4.5}).json()
    assert updated["display_score"] == 4.5
