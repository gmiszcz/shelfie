"""Dynamic relative rating engine (MVP).

Model: regularised Bradley-Terry fitted by MM (minorise-maximise) iterations.

* Every rated book starts from a prior strength derived from its 1-5 star rating
  (``beta0 = stars - 3``), expressed as virtual comparisons against a phantom "anchor" book.
  The prior keeps the fit well-posed when the comparison graph is sparse or disconnected
  (a book that only ever won would otherwise get infinite strength).
* Each recorded pairwise choice (left / right / tie) moves the strengths.
* The fitted log-strength is mapped back to a display score on the star scale. A book's
  display score is kept within half a star of its own rating, so comparisons refine the
  order inside a star band (4.9 vs 5.0) without dragging a 3-star book to 5.

Everything is recomputable from ``books.stars`` and the ``comparisons`` log, which is why the
recompute endpoint can be triggered manually at any time.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

PRIOR_WEIGHT = 2.0  # virtual games against the anchor per book
MAX_ITERATIONS = 500
TOLERANCE = 1e-9
BAND = 0.5  # how far comparisons may move a display score away from the star rating


@dataclass(frozen=True)
class Score:
    book_id: int
    latent: float  # log-strength
    uncertainty: float  # approx. standard error of the log-strength
    display: float  # 1-5 scale, one decimal
    comparisons: int


def fit(
    stars: dict[int, float],
    comparisons: list[tuple[int, int, str]],
) -> dict[int, Score]:
    """Fit strengths for every book in ``stars`` from the comparison log."""
    ids = list(stars)
    if not ids:
        return {}
    known = set(ids)

    # wins[i][j] = how many times i beat j (a tie counts half each way).
    wins: dict[int, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    games: dict[int, int] = defaultdict(int)
    for left, right, winner in comparisons:
        if left not in known or right not in known or left == right:
            continue
        games[left] += 1
        games[right] += 1
        if winner == "left":
            wins[left][right] += 1.0
        elif winner == "right":
            wins[right][left] += 1.0
        else:
            wins[left][right] += 0.5
            wins[right][left] += 0.5

    # Prior: each book plays PRIOR_WEIGHT games against an anchor of strength 1 and wins the
    # share implied by exp(beta0) / (exp(beta0) + 1).
    prior_strength = {i: math.exp(stars[i] - 3.0) for i in ids}
    prior_wins = {i: PRIOR_WEIGHT * prior_strength[i] / (prior_strength[i] + 1.0) for i in ids}

    strength = dict(prior_strength)
    for _ in range(MAX_ITERATIONS):
        delta = 0.0
        new: dict[int, float] = {}
        for i in ids:
            total_wins = prior_wins[i] + sum(wins[i].values())
            denom = PRIOR_WEIGHT / (strength[i] + 1.0)
            opponents = set(wins[i]) | {j for j in ids if i in wins[j]}
            for j in opponents:
                n_ij = wins[i].get(j, 0.0) + wins[j].get(i, 0.0)
                if n_ij:
                    denom += n_ij / (strength[i] + strength[j])
            new[i] = max(total_wins / denom, 1e-12) if denom > 0 else strength[i]
            delta = max(delta, abs(math.log(new[i]) - math.log(strength[i])))
        strength = new
        if delta < TOLERANCE:
            break

    latent = {i: math.log(strength[i]) for i in ids}

    # Fisher information of each log-strength (prior + observed games) -> standard error.
    def information(i: int) -> float:
        p_anchor = strength[i] / (strength[i] + 1.0)
        info = PRIOR_WEIGHT * p_anchor * (1.0 - p_anchor)
        for j in set(wins[i]) | {k for k in ids if i in wins[k]}:
            n_ij = wins[i].get(j, 0.0) + wins[j].get(i, 0.0)
            p = strength[i] / (strength[i] + strength[j])
            info += n_ij * p * (1.0 - p)
        return info

    scores: dict[int, Score] = {}
    for i in ids:
        info = information(i)
        uncertainty = 1.0 / math.sqrt(info) if info > 0 else 10.0
        shift = latent[i] - (stars[i] - 3.0)
        display = stars[i] + max(-BAND, min(BAND, shift))
        display = max(0.5, min(5.0, display))
        scores[i] = Score(
            book_id=i,
            latent=round(latent[i], 6),
            uncertainty=round(uncertainty, 6),
            display=round(display, 1),
            comparisons=games[i],
        )
    return scores


def next_pair(
    scores: dict[int, Score],
    *,
    focus: int | None = None,
    exclude: set[tuple[int, int]] | None = None,
) -> tuple[int, int] | None:
    """Pick the most informative pair: closest strengths, largest combined uncertainty.

    With ``focus`` set (e.g. a book just rated 5.0), only pairs containing it are considered.
    ``exclude`` holds already-asked pairs (order-insensitive) to avoid repeats in a session.
    """
    ids = sorted(scores)
    if len(ids) < 2:
        return None
    done = {tuple(sorted(p)) for p in (exclude or set())}
    best: tuple[float, tuple[int, int]] | None = None
    for a_index, a in enumerate(ids):
        for b in ids[a_index + 1 :]:
            if focus is not None and focus not in (a, b):
                continue
            if (a, b) in done:
                continue
            sa, sb = scores[a], scores[b]
            p = 1.0 / (1.0 + math.exp(sb.latent - sa.latent))
            closeness = p * (1.0 - p)  # max 0.25 at a coin flip
            value = closeness * (sa.uncertainty + sb.uncertainty)
            if best is None or value > best[0]:
                best = (value, (a, b))
    return best[1] if best else None
