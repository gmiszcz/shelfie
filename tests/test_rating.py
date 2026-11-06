"""Rating engine (band-limited Bradley-Terry) and ratings API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services import rating
from app.services.rating import BAND_WIDTH


def test_no_comparisons_keeps_star_rating() -> None:
    scores = rating.fit({1: 5.0, 2: 4.0, 3: 3.0}, [])
    # With no comparisons every book is alone in its band -> display == stars.
    assert [scores[i].display for i in (1, 2, 3)] == [5.0, 4.0, 3.0]


def test_half_star_bands_are_honoured() -> None:
    scores = rating.fit({1: 5.0, 2: 4.5, 3: 4.0}, [])
    assert scores[1].display == 5.0
    assert scores[2].display == 4.5
    assert scores[3].display == 4.0


def test_display_never_rises_above_stars() -> None:
    # The in-band winner stays at its star value; the loser sinks, never above.
    comparisons = [(1, 2, "left")] * 30
    scores = rating.fit({1: 5.0, 2: 5.0}, comparisons)
    assert scores[1].display == 5.0  # top of the band is pinned at the star value
    assert scores[2].display < 5.0
    assert scores[1].display >= scores[2].display


def test_display_stays_within_band() -> None:
    comparisons = [(2, 1, "left")] * 40  # 2 clearly beats 1 inside the 5.0 band
    scores = rating.fit({1: 5.0, 2: 5.0}, comparisons)
    for book_id in (1, 2):
        assert 5.0 - BAND_WIDTH <= scores[book_id].display <= 5.0


def test_worst_in_band_can_reach_floor_with_evidence() -> None:
    # Three 5.0 books, one clearly worst with lots of evidence.
    comparisons = [(1, 3, "left"), (2, 3, "left"), (1, 2, "tie")] * 40
    scores = rating.fit({1: 5.0, 2: 5.0, 3: 5.0}, comparisons)
    assert scores[3].display <= 4.7  # pushed well down toward the 4.6 floor
    assert scores[3].display >= 5.0 - BAND_WIDTH


def test_bands_do_not_overlap() -> None:
    # Make the 4.5 winner strong and the 5.0 loser weak; order by stars must still hold.
    comparisons = [(2, 1, "left")] * 50  # book 2 (4.5) keeps "beating" book 1 (5.0)
    scores = rating.fit({1: 5.0, 2: 4.5}, comparisons)
    assert scores[1].display >= 5.0 - BAND_WIDTH  # 5.0 band floor is 4.6
    assert scores[2].display <= 4.5  # 4.5 band top is 4.5
    assert scores[1].display > scores[2].display  # bands never cross


def test_display_is_rounded_to_one_decimal() -> None:
    comparisons = [(1, 2, "left"), (1, 3, "left"), (2, 3, "left")] * 10
    scores = rating.fit({1: 5.0, 2: 5.0, 3: 5.0}, comparisons)
    for score in scores.values():
        assert round(score.display, 1) == score.display
        # Exactly a multiple of 0.1.
        assert abs(score.display * 10 - round(score.display * 10)) < 1e-9


def test_within_band_order_is_monotonic_in_strength() -> None:
    comparisons = [(1, 2, "left"), (2, 3, "left"), (1, 3, "left")] * 20
    scores = rating.fit({1: 5.0, 2: 5.0, 3: 5.0}, comparisons)
    # Latent strength order 1 > 2 > 3 must carry over (non-strictly) to display scores.
    assert scores[1].latent >= scores[2].latent >= scores[3].latent
    assert scores[1].display >= scores[2].display >= scores[3].display


def test_few_comparisons_stay_near_the_top() -> None:
    # One comparison should not drag the loser all the way to the band floor.
    one = rating.fit({1: 5.0, 2: 5.0}, [(1, 2, "left")])
    many = rating.fit({1: 5.0, 2: 5.0}, [(1, 2, "left")] * 40)
    assert one[2].display >= many[2].display  # shrinkage keeps the low-evidence book higher


def test_ties_and_unknown_books_are_handled() -> None:
    scores = rating.fit({1: 4.0, 2: 4.0}, [(1, 2, "tie"), (1, 99, "left")])
    assert abs(scores[1].latent - scores[2].latent) < 1e-6
    assert scores[1].comparisons == 1
    # A perfect tie inside a band leaves both at the band top.
    assert scores[1].display == scores[2].display == 4.0


def test_uncertainty_shrinks_with_comparisons() -> None:
    before = rating.fit({1: 4.0, 2: 4.0}, [])
    after = rating.fit({1: 4.0, 2: 4.0}, [(1, 2, "left"), (2, 1, "left")] * 5)
    assert after[1].uncertainty < before[1].uncertainty


def test_band_of_helper() -> None:
    assert rating.band_of(5.0) == (4.6, 5.0)
    assert rating.band_of(4.5) == (4.1, 4.5)
    assert rating.band_of(1.0) == (0.6, 1.0)


def test_next_pair_prefers_same_band_then_boundary() -> None:
    stars = {1: 5.0, 2: 5.0, 3: 4.5, 4: 2.0}
    scores = rating.fit(stars, [])
    # Two 5.0 books share a band -> they win over any cross-band pair.
    assert rating.next_pair(scores, stars) == (1, 2)
    focused = rating.next_pair(scores, stars, focus=3)
    assert focused is not None and 3 in focused
    # With the same-band pair excluded, the adjacent boundary (5.0 vs 4.5) beats the far pair.
    boundary = rating.next_pair(scores, stars, exclude={(1, 2)})
    assert boundary is not None and 4 not in boundary


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


def test_half_star_rating_accepted_and_recomputed(client: TestClient) -> None:
    book_id = _add(client, "A", 3.5, "va")
    assert client.get(f"/api/books/{book_id}").json()["display_score"] == 3.5
    updated = client.patch(f"/api/books/{book_id}", json={"stars": 4.5}).json()
    assert updated["display_score"] == 4.5


def test_non_half_star_is_rejected(client: TestClient) -> None:
    body = {"title": "Bad", "google_volume_id": "vbad", "stars": 3.3, "status": "finished"}
    assert client.post("/api/books", json=body).status_code == 422


def test_score_filter_bounds(client: TestClient) -> None:
    five = _add(client, "Five", 5.0, "v5")
    four_five = _add(client, "FourFive", 4.5, "v45")
    three = _add(client, "Three", 3.0, "v3")
    client.post("/api/ratings/recompute")

    # "5 stars" bucket: display_score > 4.5 and <= 5.0 -> only the 5.0 book (display 5.0).
    got = client.get("/api/books?min_score=4.5&max_score=5.0").json()
    assert [b["id"] for b in got] == [five]

    # "4.5 stars" bucket: > 4.0 and <= 4.5 -> the 4.5 book (display 4.5).
    got = client.get("/api/books?min_score=4.0&max_score=4.5").json()
    assert [b["id"] for b in got] == [four_five]

    # No bounds -> all three rated books returned.
    got = client.get("/api/books").json()
    assert {b["id"] for b in got} == {five, four_five, three}
