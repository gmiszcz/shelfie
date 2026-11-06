"""Rating engine (band-limited Bradley-Terry) and ratings API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services import rating, ratings
from app.services.rating import BAND_WIDTH, STEP


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


def test_single_comparison_moves_display_by_at_most_one_step() -> None:
    """Regression for the user's report: one comparison dropped a book by 0.5, not 0.1.

    The engine must never move a display score by more than ``STEP`` (0.1) for a single
    comparison, in a band of any size. We replay a growing comparison log one comparison at a
    time and assert every per-step delta is within one 0.1 step.
    """
    stars = {i: 5.0 for i in range(1, 9)}  # an 8-book band, like the real 5.0 shelf
    log: list[tuple[int, int, str]] = []
    prev = {i: s.display for i, s in rating.fit(stars, log).items()}
    # A varied sequence of outcomes so band strengths genuinely reshuffle.
    sequence = [
        (1, 2, "left"),
        (3, 4, "left"),
        (5, 6, "left"),
        (7, 8, "left"),
        (2, 3, "left"),
        (4, 5, "right"),
        (6, 7, "tie"),
        (1, 8, "left"),
        (2, 5, "left"),
        (3, 6, "right"),
        (4, 7, "left"),
        (1, 5, "left"),
    ]
    for left, right, winner in sequence:
        log.append((left, right, winner))
        scores = rating.fit(stars, log)
        for i, score in scores.items():
            step = abs(score.display - prev[i])
            assert step <= STEP + 1e-9, (
                f"book {i} moved {step:.2f} (> {STEP}) on comparison {(left, right, winner)}"
            )
        prev = {i: s.display for i, s in scores.items()}


def test_reaching_the_band_floor_is_gradual() -> None:
    """A clear worst-in-band needs several comparisons to reach ``stars - 0.4``, never one.

    With the per-comparison cap ``max_offset = min(0.4, 0.1 * games)`` the loser can fall at most
    0.1 per comparison, so four comparisons are needed to reach the 0.4-below floor.
    """
    # Book 2 loses every comparison to book 1 inside the 5.0 band.
    depth_by_count = {}
    for k in range(0, 6):
        scores = rating.fit({1: 5.0, 2: 5.0}, [(1, 2, "left")] * k)
        depth_by_count[k] = round(5.0 - scores[2].display, 1)
    assert depth_by_count[0] == 0.0
    assert depth_by_count[1] == 0.1  # one comparison -> exactly one 0.1 step
    assert depth_by_count[2] == 0.2
    assert depth_by_count[3] == 0.3
    assert depth_by_count[4] == 0.4  # floor reached only after four comparisons
    assert depth_by_count[5] == 0.4  # and never past it


def test_offset_cap_grows_by_one_step_per_comparison() -> None:
    """The max offset a book can hold equals ``0.1 * games`` until it saturates at 0.4."""
    for games, expected_cap in [(0, 0.0), (1, 0.1), (2, 0.2), (3, 0.3), (4, 0.4), (10, 0.4)]:
        scores = rating.fit({1: 5.0, 2: 5.0}, [(1, 2, "left")] * games)
        assert round(5.0 - scores[2].display, 1) <= expected_cap + 1e-9


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
    assert (
        one[2].display >= many[2].display
    )  # the per-comparison cap keeps the low-evidence book higher


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


def test_next_pair_only_pairs_within_the_same_group() -> None:
    stars = {1: 5.0, 2: 5.0, 3: 5.0, 4: 5.0}
    scores = rating.fit(stars, [])
    groups: dict[int, str | None] = {1: "Fantasy", 2: "Fantasy", 3: "Thriller", 4: "Thriller"}
    pair = rating.next_pair(scores, stars, groups=groups)
    assert pair is not None
    assert groups[pair[0]] == groups[pair[1]]  # never crosses categories


def test_next_pair_never_pairs_an_uncategorised_book_across_categories() -> None:
    stars = {1: 5.0, 2: 5.0, 3: 5.0}
    scores = rating.fit(stars, [])
    # Book 3 has no category; it may only pair with another None-group book, of which there is none.
    groups: dict[int, str | None] = {1: "Fantasy", 2: "Fantasy", 3: None}
    pair = rating.next_pair(scores, stars, groups=groups, focus=3)
    assert pair is None  # 3 cannot be paired with a Fantasy book


def test_group_of_prefers_shelf_then_category() -> None:
    from types import SimpleNamespace
    from typing import cast

    from app.schemas.books import Book

    def mk(shelves: list[str], categories: list[str]) -> Book:
        # group_of only reads .shelves and .categories; a lightweight stub keeps the test focused.
        return cast(Book, SimpleNamespace(shelves=shelves, categories=categories))

    assert ratings.group_of(mk(["Fantasy"], ["Fiction"])) == "Fantasy"
    assert ratings.group_of(mk([], ["Fiction"])) == "Fiction"
    assert ratings.group_of(mk([], [])) is None


def _add(
    client: TestClient,
    title: str,
    stars: float | None,
    vol: str,
    shelves: list[str] | None = None,
) -> int:
    body = {
        "title": title,
        "google_volume_id": vol,
        "stars": stars,
        "status": "finished",
        "shelves": shelves or [],
    }
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


def test_pair_respects_selected_group(client: TestClient) -> None:
    f1 = _add(client, "F1", 5, "f1", shelves=["Fantasy"])
    f2 = _add(client, "F2", 5, "f2", shelves=["Fantasy"])
    _add(client, "T1", 5, "t1", shelves=["Thriller"])
    _add(client, "T2", 5, "t2", shelves=["Thriller"])

    # Asking for the Fantasy group only ever returns the two Fantasy books.
    pair = client.get("/api/ratings/pair?group=Fantasy").json()
    assert {pair["left"]["id"], pair["right"]["id"]} == {f1, f2}

    # And every suggested pair shares one shelf even with no group pinned.
    pair = client.get("/api/ratings/pair").json()
    left_shelves = set(pair["left"]["shelves"])
    right_shelves = set(pair["right"]["shelves"])
    assert left_shelves & right_shelves


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
