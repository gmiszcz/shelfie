# Rating Engine — Dynamic Relative Rating System

Shelfie turns a coarse 1–5 star rating into a **continuous latent score** by asking the user to
compare their top books pairwise ("left or right?"). When a book earns 5.0, a short comparison
session places it precisely among the other favorites, so 4.9 and 5.0 can be told apart.

The core problem: recover a continuous latent strength from sparse, single-rater binary
comparisons, then map it back to a 1–5 decimal display.

## Model options

### Elo

Expected score (logistic in rating difference):

```
E_A = 1 / (1 + 10^((R_B - R_A) / 400))
```

Update after each comparison:

```
R_A' = R_A + K * (S_A - E_A)       # S_A = 1 win, 0 loss, 0.5 tie
```

`K` controls volatility: ~40 for new entries, 24–32 default, 10–16 for settled ratings. A per-book
`K` that decays with comparison count is the practical pattern.

- **Pros:** trivial, O(1) incremental update, no batch refit.
- **Cons:** no uncertainty tracking, order-dependent (early comparisons overweighted).

### Bradley-Terry (BT)

Win probability from latent strengths:

```
P(i beats j) = s_i / (s_i + s_j)
```

With `s_i = exp(β_i)` this is the same logistic as Elo — Elo is "online BT". Fit by batch MLE
(Zermelo / MM — minorization-maximization), cheap at personal-library scale.

- **Existence caveat:** the MLE exists only if the comparison graph is *strongly connected*. Sparse
  single-user data often breaks this (a book that only ever won → infinite strength). Fix with a
  weak Bayesian prior (one virtual comparison against an average book), which also gives sane scores
  for books with 0–1 comparisons.
- **Ties:** vanilla BT has none; use the Rao–Kupper or Davidson extension (explicit "about the
  same" button), or score a tie 0.5/0.5 as in Elo.
- **Pros:** principled, order-independent global scale, uncertainty available from the Hessian.
- **Cons:** needs a batch refit (negligible cost here), fragile without a prior.

### Uncertainty-aware: TrueSkill & Glicko/Glicko-2

Track confidence, not just a point estimate.

- **TrueSkill:** skill as `N(μ, σ²)`, Bayesian updates; conservative display ≈ `μ − 3σ`. 1-vs-1
  degenerates to a clean two-player update.
- **Glicko/Glicko-2:** Elo + a Rating Deviation (RD) that grows with inactivity and shrinks with
  comparisons; Glicko-2 adds volatility.
- **What uncertainty buys:** σ/RD tells you which books are least pinned down → the best targets for
  the next comparison (active learning), honest early scores, faster convergence from few
  comparisons. **Cost:** more state and tuning; compute is negligible for a personal library.

## Design for Shelfie

**Seeding from stars.** Map the 1–5 star to a starting strength with wide initial uncertainty, e.g.
`β₀ = stars − 3` (5★ → +2). Only 5.0 books enter the pool, so they seed near the same high value
with large σ, and comparisons spread the ties apart — exactly the "refine 4.9 vs 5.0" case.

**Picking pairs (active learning).** Don't compare at random — compare for maximum information:
- **Expected Information Gain (EIG):** pick the pair whose outcome most reduces posterior
  uncertainty.
- **Near-ties:** in practice that is pairs with close predicted outcome (≈50/50) **and** high
  combined uncertainty — books with overlapping score distributions.
- **Binary-search insertion:** when a new 5.0 arrives, compare it against the book it's predicted to
  be nearest, then walk outward — O(log n) comparisons instead of comparing against everything.
- Keep the comparison graph connected (an MST over inverse-information-gain) so the BT fit stays
  well-posed.

**Latent → 1–5 display.** The latent scale is relative/interval, so apply an affine map then clamp:

```
z_i       = (β_i − mean) / spread
display_i = clamp(center + gain * z_i, 1.0, 5.0)    # rounded to 1 decimal
```

Because only 5.0 books are compared, set `center ≈ 4.8–5.0` and a small `gain` so refined scores
land in a tight band (e.g. 4.6–5.0) — "all excellent, but here's the order". Keep the raw star
rating as a floor so a 3★ book never drifts into 5.0 territory.

**Trigger sessions.** On a new 5.0 (short insertion session, 3–6 comparisons); optionally when a
book's σ/RD exceeds a threshold (stale / never well-pinned). Cap session length to avoid fatigue.

**Recalibration.** Online models (Elo/Glicko): let RD grow with time so idle books become eligible
for re-comparison. Batch BT: re-run the MM fit over all stored comparisons whenever the pool changes
materially (milliseconds at this scale), removing Elo's order-dependence.

## Recommendation

**Start with regularized Bradley-Terry (batch MM fit).**
- Tiny data volume → batch refit is effectively free, so the usual objection doesn't apply.
- Order-independent → a stable ranking of favorites, unlike incremental Elo.
- A weak prior fixes the connectivity/infinite-strength failure and gives usable scores from the
  first comparison.
- Clean log-strength → affine → 1–5 display mapping.

**Use plain Elo** for the MVP if you want the least code (a decaying K gets ~80% of the value in
~20 lines), accepting order-dependence and no uncertainty.

**Add Bayesian BT (same family, adds posterior σ)** when you want EIG-based pair selection and
staleness handling — this keeps one strength scale rather than switching paradigms to
TrueSkill/Glicko.

## Data model

```
Rating
  book_id
  stars_raw          # original 1-5 (anchor, never overwritten)
  latent_strength    # beta_i (log-strength) or Elo R_i
  uncertainty        # sigma / RD (null for plain Elo)
  volatility         # Glicko-2 only
  comparison_count   # drives K decay / staleness
  last_compared_at   # drives RD growth / recalibration
  display_score      # derived 1-5 decimal, recomputed on refit

Comparison           # ground-truth event log — kept forever
  id · session_id
  book_left_id · book_right_id
  winner             # left | right | tie
  created_at
```

**Key principle:** store the raw comparison events, not just derived scores. Every score (BT fit,
Elo replay, uncertainty, display mapping) is recomputable from the `Comparison` log, so the rating
model can change later without losing data.

## Sources

- Elo formula, K-factor, Elo↔BT: metricgate.com/docs/elo-rating, calculatorlib.com
- Bradley-Terry MLE / MM, existence, ties: arxiv.org/html/2207.00076v1, arxiv.org/html/1411.1168v1,
  arxiv.org/html/2110.11487v2
- Active sampling / EIG / MST pair selection: arxiv.org/html/1810.08851v1, arxiv.org/pdf/2004.05691
- TrueSkill, Glicko/Glicko-2: arxiv.org/html/2303.14857v1, arxiv.org/html/2104.14012
