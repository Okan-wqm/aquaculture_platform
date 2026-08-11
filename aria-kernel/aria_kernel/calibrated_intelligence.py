"""Calibrated intelligence — the closed-form math that lets ARIA weigh
itself by evidence instead of by hand-set constants (ORPHAN-HIGH-627).

Two primitives, both deterministic and recomputable from append-only
ledgers — the only kind of intelligence this kernel is allowed to have:

* **Beta-Binomial posteriors** over per-source precision. Every operator
  verdict (true_positive / false_positive) updates `Beta(tp+a, fp+b)`;
  a source's hand-set base weight is scaled by the ratio of its posterior
  mean to its prior mean, clamped. No labels → multiplier exactly 1.0 (the
  hand-set weight is the prior belief and stays authoritative until
  evidence arrives); labels move it, smoothly, with small-sample shrinkage
  built into the conjugate update. Closed form: no fitting, no iteration,
  no dependency.

* **Seeded Thompson sampling** over source effectiveness. The
  pressure-source-effectiveness ledger already records the reward signal
  (cycles_minted / cycles_merged); Thompson sampling turns it into an
  exploration-aware ranking: each source draws from its own posterior and
  the draw order allocates attention. Seeded by the caller (cycle id /
  date) so a replayed cycle ranks identically — `random.betavariate` under
  a fixed `random.Random(seed)` is deterministic, which keeps the
  audit-replay contract intact.

The LLM's role is unchanged: it produces hypotheses and reads evidence.
The DECISION weights come from this math, and every number here can be
re-derived from the ledgers by anyone, later, exactly.
"""
from __future__ import annotations

import hashlib
import random
from typing import Any

# The prior encodes "the hand-set weight already reflects an informed
# belief": mean 0.8 (a=4, b=1) rather than uninformative 0.5, so the first
# false positive does not halve a source's standing overnight.
PRIOR_A = 4.0
PRIOR_B = 1.0

# A source can lose at most 4x and gain at most 1.25x of its hand-set
# weight from labels alone — evidence adjusts, it does not overthrow;
# overthrow is the operator's `pressure weight-override` act.
MULTIPLIER_FLOOR = 0.25
MULTIPLIER_CEIL = 1.25


def beta_posterior(
    tp: int, fp: int, *, prior_a: float = PRIOR_A, prior_b: float = PRIOR_B
) -> dict[str, float]:
    alpha = prior_a + max(0, int(tp))
    beta = prior_b + max(0, int(fp))
    total = alpha + beta
    mean = alpha / total
    variance = (alpha * beta) / (total * total * (total + 1.0))
    return {
        "alpha": alpha,
        "beta": beta,
        "mean": mean,
        "stddev": variance ** 0.5,
        "observations": float(max(0, int(tp)) + max(0, int(fp))),
    }


def calibrated_multiplier(
    tp: int, fp: int, *, prior_a: float = PRIOR_A, prior_b: float = PRIOR_B
) -> dict[str, Any]:
    """How much the evidence says to scale a hand-set weight.

    multiplier = posterior_mean / prior_mean, clamped. Zero observations →
    exactly 1.0 by construction (posterior == prior), which is the load-
    bearing property: calibration must be a no-op until labels exist.
    """
    posterior = beta_posterior(tp, fp, prior_a=prior_a, prior_b=prior_b)
    prior_mean = prior_a / (prior_a + prior_b)
    raw = posterior["mean"] / prior_mean
    return {
        "multiplier": min(MULTIPLIER_CEIL, max(MULTIPLIER_FLOOR, raw)),
        "posterior": posterior,
    }


def source_feedback_counts(feedback_rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """tp/fp per pressure source, from the operator-feedback ledger.

    Same row reading as calibration's recommendation pass (metadata's
    pressure_source, falling back to tool_id) so the two views of the same
    ledger cannot disagree about attribution.
    """
    by_source: dict[str, dict[str, int]] = {}
    for row in feedback_rows:
        source = str(
            (row.get("metadata") or {}).get("pressure_source")
            or row.get("tool_id")
            or "unknown"
        )
        verdict = str(row.get("verdict") or row.get("kind") or "")
        bucket = by_source.setdefault(source, {"tp": 0, "fp": 0})
        if verdict == "true_positive":
            bucket["tp"] += 1
        elif verdict == "false_positive":
            bucket["fp"] += 1
    return by_source


def calibrate_source_weights(
    base_weights: dict[str, int | float],
    feedback_rows: list[dict[str, Any]],
    *,
    operator_overridden: set[str] | frozenset[str] = frozenset(),
) -> dict[str, dict[str, Any]]:
    """Evidence-scaled weights for every source, operator overrides excluded.

    An operator's `pressure weight-override` is a deliberate act with an
    approval ref; calibration never second-guesses it — those sources pass
    through at multiplier 1.0 with the reason recorded.
    """
    counts = source_feedback_counts(feedback_rows)
    calibrated: dict[str, dict[str, Any]] = {}
    for source, base in base_weights.items():
        if source in operator_overridden:
            calibrated[source] = {
                "base": float(base),
                "weight": float(base),
                "multiplier": 1.0,
                "reason": "operator_override_wins",
            }
            continue
        bucket = counts.get(source, {"tp": 0, "fp": 0})
        scaled = calibrated_multiplier(bucket["tp"], bucket["fp"])
        calibrated[source] = {
            "base": float(base),
            "weight": float(base) * scaled["multiplier"],
            "multiplier": scaled["multiplier"],
            "tp": bucket["tp"],
            "fp": bucket["fp"],
            "posterior_mean": scaled["posterior"]["mean"],
            "posterior_stddev": scaled["posterior"]["stddev"],
        }
    return calibrated


def deterministic_seed(*parts: str) -> int:
    """A replay-stable seed from cycle identity — never wall-clock."""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:16], 16)


def thompson_rank(
    candidates: list[dict[str, Any]],
    *,
    seed: int,
    prior_a: float = 1.0,
    prior_b: float = 1.0,
) -> list[dict[str, Any]]:
    """Exploration-aware ranking: one Beta draw per candidate, seeded.

    ``candidates``: [{"key", "successes", "trials"}]. A candidate with no
    history draws from the uninformative prior — which is the exploration
    guarantee: a brand-new source sometimes wins the slot, so the system
    cannot starve what it has never tried. Same seed → same draws → same
    order: replay holds.
    """
    rng = random.Random(seed)
    ranked = []
    for candidate in sorted(candidates, key=lambda c: str(c.get("key"))):
        successes = max(0, int(candidate.get("successes") or 0))
        trials = max(successes, int(candidate.get("trials") or 0))
        failures = trials - successes
        draw = rng.betavariate(prior_a + successes, prior_b + failures)
        ranked.append({
            "key": str(candidate.get("key")),
            "draw": draw,
            "successes": successes,
            "trials": trials,
        })
    ranked.sort(key=lambda r: (-r["draw"], r["key"]))
    return ranked


__all__ = [
    "MULTIPLIER_CEIL",
    "MULTIPLIER_FLOOR",
    "PRIOR_A",
    "PRIOR_B",
    "beta_posterior",
    "calibrate_source_weights",
    "calibrated_multiplier",
    "deterministic_seed",
    "source_feedback_counts",
    "thompson_rank",
]
