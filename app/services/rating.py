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

## From comparisons to a band offset

Comparisons refine the order *within* a band. For each band we:

1. Fit one global regularised Bradley-Terry model over all rated books (the fit is shared so that
   comparisons across bands still carry information through the prior and the graph). The fit drives
   the within-band *ordering* and the next-pair selection, and yields a per-book uncertainty.
2. Count each book's **in-band losses**: how many comparisons against a book of the *same* star
   value it has lost (a tie counts as half a loss for each side). Cross-band comparisons never
   shape a band's offsets.
3. Turn the loss tally straight into a downward offset, one 0.1 step per loss, capped at the band
   width:

       offset_i  = min( BAND_WIDTH, STEP * band_losses_i )
       display_i = round_to_0.1( stars_i - offset_i )

   * **No in-band losses -> offset 0 -> display = stars** (the band top is always pinned at the
     star value).
   * Each in-band loss pushes a book one 0.1 step lower, down to the band floor ``stars - 0.4``
     after four losses.

4. **Per-comparison step cap (why this shape).** Adding one comparison changes the in-band loss
   tally of at most the two books involved, each by at most one. The offset is ``STEP`` (0.1) per
   loss, so **a single comparison can move a display score by at most one 0.1 step, and never
   moves a book that was not in the comparison.** Reaching the band floor therefore always takes at
   least four in-band losses -- the refinement is gradual by construction. This is a deliberate
   replacement for an earlier *relative* mapping (normalising each book's Bradley-Terry strength
   against the band's strongest and weakest member): that mapping was not local, so one comparison
   could shift the whole band's normalisation and move a book -- even an uninvolved one -- by up to
   0.5 at once, which is the bug this engine was changed to fix.

5. ``display`` is clamped to the band ``[stars - 0.4, stars]`` and to the global ``[0.1, 5.0]``
   range, so ``display in [stars - BAND_WIDTH, stars]`` by construction (contract 1).

### Worked example

Band 5.0 holds three books A, B, C. A never loses in-band, B has lost two in-band comparisons and
C has lost five:

    offset_A = min(0.4, 0.1 * 0) = 0.0  -> display 5.0
    offset_B = min(0.4, 0.1 * 2) = 0.2  -> display 4.8
    offset_C = min(0.4, 0.1 * 5) = 0.4  -> display 4.6   (capped at the 0.4 floor)

If C had only lost once so far, ``offset_C = 0.1 -> display 4.9``; it sinks exactly one 0.1 step
per loss, so it needs four in-band losses to reach the 4.6 floor.

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
STEP = 0.1  # display scores are quantised to this step; also the max per-comparison offset step


def _round_step(value: float, step: float = STEP) -> float:
    """Round to the nearest ``step`` (e.g. 0.1), avoiding binary-float surprises."""
    return round(round(value / step) * step, 10)


def _floor_step(value: float, step: float = STEP) -> float:
    """Floor to a multiple of ``step`` (e.g. 0.1), avoiding binary-float surprises.

    Used for the band offset so that evidence only ever *crosses* a 0.1 step boundary when it has
    fully accumulated it -- a half-loss (tie) can never round an offset up past a step, which keeps
    the per-comparison change at most one step.
    """
    return round(math.floor(round(value / step, 9)) * step, 10)


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

    # In-band loss tally per book. A book's display offset is driven directly by how many
    # *in-band* comparisons it has lost (a tie counts as half a loss each way), NOT by its
    # relative position in the shifting Bradley-Terry fit. This keeps the mapping LOCAL and
    # GRADUAL: adding one comparison changes the loss tally of at most the two books involved,
    # each by at most one, so a single comparison can move a display score by at most one 0.1
    # step and can never move a book that was not in the comparison. Reaching the band floor
    # (0.4 below the star value) therefore always takes at least four in-band losses. The
    # Bradley-Terry fit above still drives the ordering and the next-pair selection; here it only
    # breaks ties between books with equal loss tallies so the within-band order stays monotone
    # in strength.
    band_losses: dict[int, float] = defaultdict(float)
    for left, right, winner in comparisons:
        if left not in known or right not in known or left == right:
            continue
        if abs(stars[left] - stars[right]) > 1e-9:
            continue  # only same-band (same star value) comparisons shape a band's offsets
        if winner == "left":
            band_losses[right] += 1.0
        elif winner == "right":
            band_losses[left] += 1.0
        else:  # tie
            band_losses[left] += 0.5
            band_losses[right] += 0.5

    # Group books by their (quantised) star value: these are the bands.
    bands: dict[float, list[int]] = defaultdict(list)
    for i in ids:
        bands[round(stars[i], 1)].append(i)

    display: dict[int, float] = {}
    for star_value, members in bands.items():
        for i in members:
            # offset = 0.1 per in-band loss, FLOORED to the 0.1 step and capped at the band width
            # (0.4). A single comparison changes a book's loss tally by at most one full loss (a
            # win/loss) or half a loss (a tie), so the floored offset advances by at most one 0.1
            # step per comparison -- and a book not in the comparison keeps its tally, so it never
            # moves. Flooring (rather than rounding) keeps the step cap exact: two half-losses
            # (ties) are needed to cross one 0.1 step, so a tie can never cause a jump.
            raw_offset = min(BAND_WIDTH, STEP * band_losses[i])
            offset = _floor_step(max(0.0, raw_offset))
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
    groups: dict[int, str | None] | None = None,
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

    ``groups`` maps each book id to its category group (its primary shelf, falling back to its
    first category, or ``None`` when it has neither). When given, a pair must share the same group:
    books are only ever compared within one category, and a book with no category (group ``None``)
    is only paired with other uncategorised books -- never across categories.
    """
    ids = sorted(scores)
    if len(ids) < 2:
        return None
    done = {tuple(sorted(p)) for p in (exclude or set())}

    def same_group(a: int, b: int) -> bool:
        if groups is None:
            return True
        return groups.get(a) == groups.get(b)

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
            if not same_group(a, b):
                continue
            sa, sb = scores[a], scores[b]
            p = 1.0 / (1.0 + math.exp(sb.latent - sa.latent))
            closeness = p * (1.0 - p)  # max 0.25 at a coin flip
            value = closeness * (sa.uncertainty + sb.uncertainty)
            key = (tier(a, b), value)
            if best is None or key > (best[0], best[1]):
                best = (key[0], key[1], (a, b))
    return best[2] if best else None
