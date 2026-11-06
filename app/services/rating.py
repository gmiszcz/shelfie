"""Dynamic relative rating engine with band-limited, downward-only refinement.

Model: regularised Bradley-Terry fitted by MM (minorise-maximise) iterations, followed by a
per-band mapping of the fitted strengths to a one-decimal display score.

## Star bands

The user rates in half stars (``stars`` is a float in 0.5 steps, 0.5..5.0). Each half-star value
owns a **band** on the display scale:

    band(stars) = [stars - BAND_WIDTH, stars]     with BAND_WIDTH = 0.4

So a 5.0 book lives in ``4.6..5.0``, a 4.5 book in ``4.1..4.5``, a 4.0 book in ``3.6..4.0`` and so
on. Because consecutive half-star values are 0.5 apart and a band is only 0.4 wide, **bands never
overlap**: the top of one band (``stars``) always sits above the top of the band below it
(``stars - 0.5``). The order by user stars is therefore always preserved; comparisons only reorder
books *inside* a band and can only push a book **downward** from its star value, never up and never
into a neighbour's band. The top of a band always stays pinned at its star value.

## From Bradley-Terry strength to a band offset

Comparisons refine the order *within* a band. For each band we:

1. Fit one global regularised Bradley-Terry model over all rated books (the fit is shared so that
   comparisons across bands still carry information through the prior and the graph).
2. Inside each band, look only at the books that share that star value and rank them by fitted
   log-strength ``latent``.
3. Map each book's rank/strength to a downward offset in ``[0, BAND_WIDTH]``:

       best in band      -> offset 0.0        -> display = stars
       worst in band      -> offset up to 0.4  -> display = stars - 0.4   (only with enough evidence)

   The raw offset is the book's strength position within the band, normalised so the strongest book
   in the band gets 0 and the weakest gets ``BAND_WIDTH``:

       raw_offset_i = BAND_WIDTH * (latent_max_band - latent_i) / (latent_max_band - latent_min_band)

   (a band with one book, or with all-equal strengths, gives every member offset 0 -> display =
   stars, which is the correct "no evidence yet" behaviour).

4. **Uncertainty shrinkage.** A book with few comparisons should stay near the top of its band
   (we are not yet sure it is worse than its band-mates). We shrink the raw offset toward 0 by a
   confidence factor that grows with the amount of evidence (the number of comparisons ``games``
   involving the book):

       confidence_i = games_i / (games_i + SHRINK_PRIOR)     in [0, 1)
       offset_i      = round_to_0.1( raw_offset_i * confidence_i )

   With no comparisons ``games = 0``, ``confidence = 0``, and the book stays at ``stars``. As
   comparisons accumulate, ``confidence -> 1`` and the book can reach its full raw offset, down to
   ``stars - 0.4`` for the clear worst-in-band.

5. ``display = round_to_0.1(stars - offset)``, clamped to the band ``[stars - 0.4, stars]`` and to
   the global ``[0.1, 5.0]`` range. The final value is guaranteed to lie within
   ``[stars - BAND_WIDTH, stars]`` (contract 1).

### Worked example

Band 5.0 holds three books A, B, C with fitted log-strengths ``latent = {A: 1.0, B: 0.4, C: 0.0}``,
all with many comparisons (``confidence ~= 1``):

    raw_offset_A = 0.4 * (1.0 - 1.0) / (1.0 - 0.0) = 0.00  -> display 5.0
    raw_offset_B = 0.4 * (1.0 - 0.4) / (1.0 - 0.0) = 0.24  -> round 0.2 -> display 4.8
    raw_offset_C = 0.4 * (1.0 - 0.0) / (1.0 - 0.0) = 0.40  -> display 4.6

If C had only one comparison so ``confidence_C = 1 / (1 + 2) ~= 0.33``:

    offset_C = round_to_0.1(0.40 * 0.33) = round_to_0.1(0.13) = 0.1 -> display 4.9

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

BAND_WIDTH = 0.4  # how far below its star value a book's display score may sink
STEP = 0.1  # display scores are quantised to this step
SHRINK_PRIOR = 2.0  # Fisher-information scale for the uncertainty-shrinkage confidence factor


def _round_step(value: float, step: float = STEP) -> float:
    """Round to the nearest ``step`` (e.g. 0.1), avoiding binary-float surprises."""
    return round(round(value / step) * step, 10)


@dataclass(frozen=True)
class Score:
    book_id: int
    latent: float  # log-strength
    uncertainty: float  # approx. standard error of the log-strength
    display: float  # 0.1-5.0 scale, one decimal, within [stars - 0.4, stars]
    comparisons: int


def _fit_strengths(
    ids: list[int],
    stars: dict[int, float],
    wins: dict[int, dict[int, float]],
) -> dict[int, float]:
    """Regularised Bradley-Terry MM fit. Returns a strength per book."""
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
    return strength


def fit(
    stars: dict[int, float],
    comparisons: list[tuple[int, int, str]],
) -> dict[int, Score]:
    """Fit strengths for every book in ``stars``, then map each to its band display score."""
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

    strength = _fit_strengths(ids, stars, wins)
    latent = {i: math.log(strength[i]) for i in ids}

    # Fisher information of each log-strength (prior + observed games).
    def information(i: int) -> float:
        p_anchor = strength[i] / (strength[i] + 1.0)
        info = PRIOR_WEIGHT * p_anchor * (1.0 - p_anchor)
        for j in set(wins[i]) | {k for k in ids if i in wins[k]}:
            n_ij = wins[i].get(j, 0.0) + wins[j].get(i, 0.0)
            p = strength[i] / (strength[i] + strength[j])
            info += n_ij * p * (1.0 - p)
        return info

    info_by_id = {i: information(i) for i in ids}

    # Group books by their (quantised) star value: these are the bands.
    bands: dict[float, list[int]] = defaultdict(list)
    for i in ids:
        bands[round(stars[i], 1)].append(i)

    display: dict[int, float] = {}
    for star_value, members in bands.items():
        latents = [latent[i] for i in members]
        lat_max, lat_min = max(latents), min(latents)
        spread = lat_max - lat_min
        for i in members:
            if spread <= 1e-12:
                raw_offset = 0.0  # one book, or all equal -> nothing to refine
            else:
                raw_offset = BAND_WIDTH * (lat_max - latent[i]) / spread
            # Uncertainty shrinkage: few comparisons -> stay near the top of the band. Confidence
            # grows with the amount of evidence (comparisons involving this book), so a book with
            # no comparisons gets ~0 offset (sits at its star value) and a well-compared one can
            # reach its full raw offset, down to the band floor.
            confidence = games[i] / (games[i] + SHRINK_PRIOR)
            offset = _round_step(raw_offset * confidence)
            offset = max(0.0, min(BAND_WIDTH, offset))
            value = _round_step(star_value - offset)
            # Clamp into the band and the global display range.
            value = max(star_value - BAND_WIDTH, min(star_value, value))
            display[i] = round(max(0.1, min(5.0, value)), 1)

    scores: dict[int, Score] = {}
    for i in ids:
        info = info_by_id[i]
        uncertainty = 1.0 / math.sqrt(info) if info > 0 else 10.0
        scores[i] = Score(
            book_id=i,
            latent=round(latent[i], 6),
            uncertainty=round(uncertainty, 6),
            display=display[i],
            comparisons=games[i],
        )
    return scores


def band_of(stars: float) -> tuple[float, float]:
    """The display-score band a star value owns: ``[stars - BAND_WIDTH, stars]``."""
    top = round(stars, 1)
    return (round(top - BAND_WIDTH, 1), top)


def next_pair(
    scores: dict[int, Score],
    stars: dict[int, float] | None = None,
    *,
    focus: int | None = None,
    exclude: set[tuple[int, int]] | None = None,
) -> tuple[int, int] | None:
    """Pick the most informative pair to ask the user about next.

    Preference order, highest first:

    * pairs **within the same band** (same star value) -- that is where comparisons actually refine
      the order;
    * pairs on an **adjacent-band boundary** -- the bottom of a band versus the top of the band just
      below it (e.g. the 4.6 end of the 5.0 band versus a 4.5-starred book), which confirms the
      bands sit in the right place;
    * everything else.

    Within a tier the pair with the closest predicted outcome and the largest combined uncertainty
    (the least-pinned-down books) wins. ``focus`` restricts to pairs containing that book;
    ``exclude`` holds already-asked pairs (order-insensitive) to avoid repeats in a session.
    """
    ids = sorted(scores)
    if len(ids) < 2:
        return None
    done = {tuple(sorted(p)) for p in (exclude or set())}

    def tier(a: int, b: int) -> int:
        if stars is None:
            return 1
        sa, sb = stars.get(a), stars.get(b)
        if sa is None or sb is None:
            return 0
        if abs(sa - sb) < 1e-9:
            return 2  # same band -- most valuable
        if abs(abs(sa - sb) - 0.5) < 1e-9:
            return 1  # adjacent bands' boundary
        return 0

    best: tuple[int, float, tuple[int, int]] | None = None
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
            key = (tier(a, b), value)
            if best is None or key > (best[0], best[1]):
                best = (key[0], key[1], (a, b))
    return best[2] if best else None
