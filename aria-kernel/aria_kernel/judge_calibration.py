"""Plan 024 §A — closed-loop judge calibration.

ARIA's trust rests on the judge → consensus chain, yet nothing measured whether
the judges are right. ``tool_health.compute_metrics`` scores the ADAPTER
(``tool_health.py`` precision), and a full grep shows no ``judge_id``-keyed
precision anywhere. This module fills that gap WITHOUT re-invoking any LLM: it
joins every ``ai_judge`` verdict to the ground-truth verdict on the same finding
and scores each ``judge_id`` over the accumulated feedback ledger.

Ground truth for a judge = an operator row or an ANCHOR consensus row (JJ-1:
>= 3 judges) on the same ``(run_id, finding_id, judgment_group_id)`` the judge
also voted on — the exact join ``generate_ai_consensus`` already uses to form
consensus. ``human`` outranks ``ai_consensus`` when both exist.

Why the anchor floor matters HERE most of all: a 2-judge consensus is formed
from the very judges being scored, so grading them against it graded each
judge partly against itself and rewarded agreement rather than correctness.

Cheap by construction: precision / recall / calibration come from verdicts and
confidences ALREADY recorded. NOTE on recall: this is recall over *surfaced*
findings only (the judge voted, and a ground truth exists). True
gold-set-replay recall — re-invoking judges on known findings they never saw —
needs LLM re-invocation and is tracked for Plan 025 (ARIA-024-D1).
"""
from __future__ import annotations

import math
import random
import uuid
from pathlib import Path
from typing import Any

from .calibrated_intelligence import deterministic_seed
from .feedback_store import (
    GROUND_TRUTH_SOURCE_TYPES,
    append_jsonl,
    is_ground_truth_row,
    load_feedback,
)
from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_MIN_SAMPLES: int = 10
DEFAULT_PRECISION_FLOOR: float = 0.7
# Typed-judgment plan Phase 5 (ARIA-HIGH-167, ARIA-HIGH-173) — when a judge's
# CONFIDENCE is calibrated enough to close a finding. Measured against the
# live confidence distribution (0.72–0.90 in three bins): a perfectly
# calibrated judge reads `uncalibrated` under a 10-bin ECE at n = 30 in 32 %
# of draws and in 1 % at n = 100, so the decision needs 100 truth-backed
# votes, a bootstrap upper bound on the ECE, and — the quantity the 0.80
# consensus gate actually assumes — a Wilson lower bound on the accuracy of
# the votes the judge held at 0.80 or above. 30–99 is `provisional`:
# reported, never a closer.
DEFAULT_CALIBRATION_MIN_SAMPLES: int = 100
DEFAULT_PROVISIONAL_MIN_SAMPLES: int = 30
DEFAULT_ECE_THRESHOLD: float = 0.10
DEFAULT_HIGH_CONFIDENCE_FLOOR: float = 0.80
DEFAULT_HIGH_CONFIDENCE_ACCURACY_MIN: float = 0.75
DEFAULT_CALIBRATION_BINS: int = 10
BOOTSTRAP_RESAMPLES: int = 1000
BOOTSTRAP_QUANTILE: float = 0.90
CALIBRATION_STATUSES: tuple[str, ...] = ("calibrated", "provisional", "uncalibrated", "insufficient_data")
# Mirrors judge_replay.REPLAY_GROUP_PREFIX (kept local to avoid an import cycle).
_REPLAY_GROUP_PREFIX: str = "replay:"
# WP-J D — organic calibration excludes verdicts minted by a MEASUREMENT
# lane, of which the gold-set replay was only the first: a judge's everyday
# precision/recall must not be moved by rows a lane produced on purpose
# (a replay run it was seeded for, a stability re-ask of itself, a canary
# item whose label is by construction). One SET, one member per lane, each
# member landing in the SAME commit as the lane that first mints under it
# — a prefix for a lane that does not exist is a rule about nothing.
# Mirrors are pinned to their owners' constants by test (no import cycle
# here: stability_reask and mutation_canary import this module's scoring).
#
# 'stability:' (WP-J D-1, landing in the SAME commit as the lane that first
# mints under it — stability_reask) excludes the re-ask verdicts: they are
# the same judge answering its own question a second time, and folding
# them into the organic buckets would double-count one opinion per seat.
_STABILITY_GROUP_PREFIX: str = "stability:"
# 'canary:' (WP-J D-2, same commit as the canary lane): panel verdicts on
# planted corpus items are the self-exam, not the everyday work — they are
# scored under their own prefix and never fold into the organic buckets.
_CANARY_GROUP_PREFIX: str = "canary:"
ORGANIC_EXCLUSION_PREFIXES: tuple[str, ...] = (
    _REPLAY_GROUP_PREFIX, _STABILITY_GROUP_PREFIX, _CANARY_GROUP_PREFIX,
)
# WP-J D-1 — the scoring-only truth vocabulary. An ``outcome`` row is a
# machine-verifiable outcome (red-then-green same-recipe, merged, not
# reverted — outcome_truth.py), NOT authority: GROUND_TRUTH_SOURCE_TYPES
# refuses it, so is_ground_truth_row (and every reader that owns a
# consequence — suppression, goldset admission, promotion readiness) is
# byte-identical. Only the sibling predicate below admits it, and only
# where the question is "was this judge right?".
# WP-J D-2 — 'canary' joins with the mutation-canary corpus: a label BY
# CONSTRUCTION (the planted mutant is a true positive because it was
# planted; the false claim is a false positive because nothing is wrong).
# It scores judges exactly as outcome truth does, and is refused by
# is_ground_truth_row exactly as outcome truth is. Same commit as the
# first canary mint.
CALIBRATION_TRUTH_SOURCE_TYPES: tuple[str, ...] = ("outcome", "canary")


def _group_under_excluded_prefix(row: dict[str, Any]) -> bool:
    group = str(row.get("judgment_group_id") or "")
    return any(group.startswith(prefix) for prefix in ORGANIC_EXCLUSION_PREFIXES)


def is_calibration_truth_row(row: dict[str, Any]) -> bool:
    """JJ-1, AMENDED ON THE RECORD (WP-J D-1): may this row act as TRUTH FOR
    SCORING a judge?

    The original one-predicate law (ORPHAN-HIGH-731) said one predicate,
    five readers, no per-reader re-derivation. It still does — for
    AUTHORITY. What operator decision 2026-10-18 added is a truth the judge
    fleet did not produce: the mechanical OUTCOME of the finding it judged
    (the defect demonstrably ran red, the same recipe verified the fix
    green, the fix merged and was not reverted). Scoring judges only
    against verdicts judges produced was the circularity the gold corpus
    also fights (ARIA-HIGH-125); outcome truth breaks it without minting a
    single human row.

    So there are exactly two predicates, each with one job, and this one
    DELEGATES the authority question instead of copying it:

    * ``is_ground_truth_row`` (feedback_store) — unchanged, byte-identical,
      read by every consequence owner;
    * this predicate — ``is_ground_truth_row`` for the authority sources,
      plus CALIBRATION_TRUTH_SOURCE_TYPES for the scoring-only sources.

    A source in neither is truth for nobody (an ai_judge row is a vote,
    never its own truth).
    """
    source_type = row.get("source_type") or "human"
    if source_type in GROUND_TRUTH_SOURCE_TYPES:
        return is_ground_truth_row(row)
    return source_type in CALIBRATION_TRUTH_SOURCE_TYPES


def calibration_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "calibration" / "judge-calibration.jsonl"


def _group_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("run_id") or ""),
        str(row.get("finding_id") or ""),
        str(row.get("judgment_group_id") or ""),
    )


def _observer_ids(row: dict[str, Any]) -> frozenset[str]:
    """The judges an anchor consensus row was formed from — the judges it
    can never be ground truth FOR (ARIA-HIGH-173)."""
    observers = row.get("observers") or []
    ids = {str(o.get("judge_id") or "") for o in observers if isinstance(o, dict)}
    return frozenset(i for i in ids if i)


def _human_row_is_verified(row: dict[str, Any], base_dir: str | Path | None) -> bool:
    """ARIA-HIGH-169 — a human label counts only when it SAYS it is human
    and the kernel's signature over it verifies; an absent provenance is
    not the strongest provenance, and an unsigned row is nobody's label."""
    if row.get("source_type") != "human":
        return False
    if base_dir is None:
        return True
    from .operator_feedback_signature import verify_operator_feedback_row

    return bool(verify_operator_feedback_row(row, base_dir=base_dir).valid)


def _label_stratum(row: dict[str, Any]) -> str:
    provenance = row.get("label_provenance")
    if isinstance(provenance, dict) and provenance.get("stratum"):
        return str(provenance["stratum"])
    return "unstratified"


def _label_weight(row: dict[str, Any]) -> float:
    """Horvitz-Thompson weight of a ground-truth label (ARIA-LOW-608).

    A label drawn from the queue's stratified sampling design carries the
    probability it was included at (ARIA-MEDIUM-276) precisely so an
    estimate over the sample can undo that design: each stratified label
    counts as ``1/π``. Labels from no sampling design — unstratified human
    labels and anchor consensus rows — carry no design to undo and weigh 1.
    A stratified label whose π is missing or outside ``(0, 1]`` makes the
    weighting silently wrong in a direction nobody can audit, so it is
    refused by name instead of guessed at.
    """
    provenance = row.get("label_provenance")
    if not isinstance(provenance, dict) or not provenance.get("stratum"):
        return 1.0
    pi = provenance.get("inclusion_probability")
    # isinstance lets bool through and ``nan < 0``/``nan > 1`` are both
    # False; every non-finite or out-of-range shape must be a refusal.
    if isinstance(pi, bool) or not isinstance(pi, (int, float)) or not (0.0 < float(pi) <= 1.0):
        raise GovernanceError(
            "label_inclusion_probability_invalid: "
            f"stratum {str(provenance.get('stratum'))!r} label "
            f"{str(row.get('finding_id') or row.get('run_id') or _group_key(row))!r} "
            f"carries inclusion_probability {pi!r}; a stratified label must "
            "record a finite probability in (0, 1] (ARIA-MEDIUM-276)"
        )
    return 1.0 / float(pi)


def _build_ground_truth_detail(
    rows: list[dict[str, Any]], *, base_dir: str | Path | None = None,
    unverified: list[dict[str, Any]] | None = None,
) -> dict[tuple[str, str, str], tuple[str, str, frozenset[str], float]]:
    """Best truth ``(verdict, source, observers, weight)`` per finding.

    Precedence, highest first: a verified human label, the machine OUTCOME
    of the judged finding, an anchor ai_consensus row. Human beats machine
    because the operator is the final authority; outcome beats consensus
    because the whole point of an outcome row is that the judge fleet did
    NOT produce it (ARIA-HIGH-125's circularity); an anchor row remembers
    who formed it. A human row that is not explicitly human or does not
    verify is skipped (and listed in ``unverified`` when the caller asks).
    The ``source`` of a human row carries its label stratum: ``human`` for
    a random or unstratified label, ``human_escalated`` for one drawn from
    the escalations (review C3: reported, never the basis of
    `calibrated`). The ``weight`` is the label's Horvitz-Thompson weight
    ``1/π`` (ARIA-LOW-608): 1 for anchors, outcomes and unstratified
    labels, which come from no sampling design.

    An outcome row contributes NO observers — deliberately. The
    ARIA-HIGH-173 self-exclusion below exists because an anchor this judge
    helped form is its own vote wearing a consensus hat; an outcome row is
    evidence independent of every judge, so EVERY judge of the group is
    scored against it. That is the property that makes outcome truth worth
    minting at all.
    """
    _precedence = {"human": 0, "human_escalated": 0, "outcome": 1, "ai_consensus": 2}
    truth: dict[tuple[str, str, str], tuple[str, str, frozenset[str], float]] = {}
    for row in rows:
        # JJ-1 as amended (see is_calibration_truth_row): the authority
        # predicate stays byte-identical in feedback_store; scoring reads
        # the sibling that also admits outcome truth.
        if not is_calibration_truth_row(row):
            continue
        source = row.get("source_type") or "human"
        weight = 1.0
        if source == "human" or row.get("source_type") is None:
            if not _human_row_is_verified(row, base_dir):
                if unverified is not None:
                    unverified.append(row)
                continue
            source = "human_escalated" if _label_stratum(row) == "escalated" else "human"
            weight = _label_weight(row)
        verdict = str(row.get("verdict") or "")
        if not verdict:
            continue
        key = _group_key(row)
        existing = truth.get(key)
        observers = _observer_ids(row) if source == "ai_consensus" else frozenset()
        # Feedback is append-only; an operator can correct an earlier call
        # with a later row. Last-write-wins within precedence, so a later
        # row of a strictly higher class replaces, and an equal class
        # corrects.
        if existing is None or _precedence[source] <= _precedence[existing[1]]:
            truth[key] = (verdict, source, observers, weight)
    return truth


def _build_ground_truth(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], str]:
    """Best ground-truth verdict per finding. human beats ai_consensus."""
    return {key: verdict for key, (verdict, _src, _obs, _w) in _build_ground_truth_detail(rows).items()}


def brier_score(pairs: list[tuple[float, bool]]) -> float | None:
    """Mean squared error of ``p`` against the event; None with no pairs."""
    if not pairs:
        return None
    return round(sum((p - (1.0 if hit else 0.0)) ** 2 for p, hit in pairs) / len(pairs), 4)


def brier_skill_score(pairs: list[tuple[float, bool]]) -> float | None:
    """1 − Brier / Brier of the constant base-rate forecast. A judge that
    always says 0.85 and is right 85 % of the time has an ECE near zero
    and NO skill: ECE alone must not confer `calibrated`."""
    if len(pairs) < 2:
        return None
    base_rate = sum(1.0 for _p, hit in pairs if hit) / len(pairs)
    reference = sum((base_rate - (1.0 if hit else 0.0)) ** 2 for _p, hit in pairs) / len(pairs)
    score = brier_score(pairs)
    if score is None:
        return None
    if reference <= 0.0:
        return round(1.0 - score, 4) if score > 0.0 else 0.0
    return round(1.0 - score / reference, 4)


def expected_calibration_error(pairs: list[tuple[float, bool]], *, bins: int = DEFAULT_CALIBRATION_BINS) -> dict[str, Any]:
    """Fixed-width-bin ECE of ``p`` against the event, with the bins."""
    if bins < 1:
        raise ValueError(f"calibration_bins must be >= 1, got {bins!r}")
    if not pairs:
        return {"ece": None, "bins": []}
    buckets: list[list[tuple[float, bool]]] = [[] for _ in range(bins)]
    for p, hit in pairs:
        index = min(bins - 1, max(0, int(p * bins)))
        buckets[index].append((p, hit))
    total = len(pairs)
    ece = 0.0
    rows: list[dict[str, Any]] = []
    for index, bucket in enumerate(buckets):
        lo, hi = round(index / bins, 3), round((index + 1) / bins, 3)
        if not bucket:
            rows.append({"lo": lo, "hi": hi, "count": 0, "mean_confidence": None, "accuracy": None})
            continue
        mean_confidence = sum(p for p, _hit in bucket) / len(bucket)
        accuracy = sum(1.0 for _p, hit in bucket if hit) / len(bucket)
        ece += (len(bucket) / total) * abs(accuracy - mean_confidence)
        rows.append({"lo": lo, "hi": hi, "count": len(bucket),
                     "mean_confidence": round(mean_confidence, 4), "accuracy": round(accuracy, 4)})
    return {"ece": round(ece, 4), "bins": rows}


def bootstrap_ece_upper(
    pairs: list[tuple[float, bool]], *, bins: int = DEFAULT_CALIBRATION_BINS,
    quantile: float = BOOTSTRAP_QUANTILE, resamples: int = BOOTSTRAP_RESAMPLES, seed: int = 0,
) -> float | None:
    """The ``quantile`` upper bound of the ECE over seeded bootstrap
    resamples — replay-stable, never wall-clock."""
    if not pairs:
        return None
    rng = random.Random(seed)
    values: list[float] = []
    n = len(pairs)
    for _ in range(resamples):
        sample = [pairs[rng.randrange(n)] for _ in range(n)]
        values.append(float(expected_calibration_error(sample, bins=bins)["ece"] or 0.0))
    values.sort()
    return round(values[min(len(values) - 1, max(0, int(math.ceil(quantile * len(values))) - 1))], 4)


def wilson_lower(successes: int, trials: int, *, z: float = 1.96) -> float | None:
    """Wilson score interval's lower bound for a proportion; None with no trials."""
    if trials <= 0:
        return None
    phat = successes / trials
    denominator = 1.0 + z * z / trials
    centre = phat + z * z / (2.0 * trials)
    margin = z * math.sqrt(phat * (1.0 - phat) / trials + z * z / (4.0 * trials * trials))
    return round((centre - margin) / denominator, 4)


def calibration_status(
    *, samples_with_confidence: int, ece_upper: float | None, high_confidence_accuracy_lower: float | None,
    high_confidence_trials: int, calibration_min_samples: int, provisional_min_samples: int,
    ece_threshold: float, high_confidence_accuracy_min: float,
) -> str:
    """`calibrated` ⇔ enough truth-backed votes AND a bounded ECE AND the
    high-confidence votes are accurate at the lower bound; `provisional`
    from the provisional floor; `uncalibrated` past the floor otherwise."""
    if samples_with_confidence < provisional_min_samples:
        return "insufficient_data"
    if samples_with_confidence < calibration_min_samples:
        return "provisional"
    if ece_upper is None or ece_upper > ece_threshold:
        return "uncalibrated"
    if high_confidence_trials == 0 or high_confidence_accuracy_lower is None:
        return "uncalibrated"
    if high_confidence_accuracy_lower < high_confidence_accuracy_min:
        return "uncalibrated"
    return "calibrated"


def correct_consensus_confidences(rows: list[dict[str, Any]]) -> list[float]:
    """Confidences of the consensus rows a HUMAN — or, since WP-J D-1, a
    mechanical OUTCOME — later agreed with. The only rows a conformal floor
    may be taken over (ARIA-HIGH-173: the floor used to be the 10th
    percentile of every consensus output, correct or not).

    The window was human-only, and with no operator labels it was empty
    forever: the floor could never exist, so the conformal abstention gate
    never fired. An outcome row is agreement the judge fleet did not
    produce (red-then-green same-recipe, merged, not reverted), which is
    exactly the evidence ARIA-HIGH-173 wanted a floor to rest on. A human
    row still outranks an outcome row on the same group.
    """
    confirming: dict[tuple[str, str, str], tuple[str, str]] = {}
    for row in rows:
        source = row.get("source_type") or "human"
        if source not in ("human", "outcome") or not row.get("verdict"):
            continue
        key = _group_key(row)
        existing = confirming.get(key)
        if existing is None or (source == "human" and existing[0] != "human"):
            confirming[key] = (source, str(row["verdict"]))
    out: list[float] = []
    for row in rows:
        if row.get("source_type") != "ai_consensus" or not isinstance(row.get("confidence"), (int, float)):
            continue
        agreed = confirming.get(_group_key(row))
        if agreed is not None and agreed[1] == str(row.get("verdict") or ""):
            out.append(float(row["confidence"]))
    return out


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def _judge_version(row: dict[str, Any]) -> tuple[str, str]:
    """J2 (SEPT-HARVEST §2) — the version of the judge that gave this verdict:
    the dispatched model and the hash of the contract it was shown
    (``agent_contract_hash``, kept by judgment_bridge). A row that names
    neither is its own (unknown) version, never the current one's."""
    return (str(row.get("model") or ""), str(row.get("agent_contract_hash") or ""))


def score_judges(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    precision_floor: float = DEFAULT_PRECISION_FLOOR,
    judgment_group_prefix: str | None = None,
    calibration_min_samples: int = DEFAULT_CALIBRATION_MIN_SAMPLES,
    provisional_min_samples: int = DEFAULT_PROVISIONAL_MIN_SAMPLES,
    ece_threshold: float = DEFAULT_ECE_THRESHOLD,
    high_confidence_floor: float = DEFAULT_HIGH_CONFIDENCE_FLOOR,
    high_confidence_accuracy_min: float = DEFAULT_HIGH_CONFIDENCE_ACCURACY_MIN,
    calibration_bins: int = DEFAULT_CALIBRATION_BINS,
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth — pure, no write.

    The same computation `compute_judge_calibration` persists, split out for
    the consumer that must see THIS cycle's calibration (ORPHAN-HIGH-784):
    the judgment pipeline computes weights in memory BEFORE the consensus
    that consumes them, while the calibration phase keeps owning the ledger
    append for audit. One computation, two call shapes, no one-cycle lag.

    Positive class = ``true_positive``. Per judge: precision, recall, accuracy,
    and a calibration signal (mean confidence on correct vs wrong calls).
    The precision the degraded/ok decision reads is the Horvitz-Thompson
    ratio estimate ``precision_ht`` (ARIA-LOW-608): every ground-truth label
    weighs ``1/π`` under the label queue's stratified sampling design, so an
    over-sampled stratum cannot dominate the estimate; the unweighted counts
    stay beside it as raw evidence. A
    judge with >= ``min_samples`` ground-truth-backed verdicts whose precision
    drops below ``precision_floor`` is reported ``degraded`` — the operator-
    visible, detectable signal that the cheap-tier judgment is slipping.

    ``judgment_group_prefix`` isolates a subset of verdicts by their
    ``judgment_group_id`` — Plan 025 §C passes ``"replay:"`` to score the
    gold-set replay independently from organic surfaced verdicts.

    J2 (SEPT-HARVEST §2) — a judge is scored only over the verdicts of its
    CURRENT version: the (model, agent_contract_hash) of its newest verdict.
    A rewritten prompt or a swapped model does not inherit the calibration
    its previous version earned; the older truth-backed verdicts are counted
    under ``prior_version`` and scored nowhere.
    """
    rows = load_feedback(base_dir=base_dir)
    if judgment_group_prefix is not None:
        rows = [
            r for r in rows
            if str(r.get("judgment_group_id") or "").startswith(judgment_group_prefix)
        ]
    else:
        # Organic calibration excludes the measurement lanes' verdicts
        # (Plan 025 §C was the first: gold-set replay) — folding them into a
        # judge's everyday buckets corrupts its precision/recall and the
        # degraded signal that proactive prioritization + the operator
        # report consume. One SET (ORGANIC_EXCLUSION_PREFIXES), one member
        # per lane, each landing with its lane.
        rows = [r for r in rows if not _group_under_excluded_prefix(r)]
    unverified_rows: list[dict[str, Any]] = []
    truth = _build_ground_truth_detail(rows, base_dir=base_dir, unverified=unverified_rows)
    if calibration_bins < 1:
        raise ValueError(f"calibration_bins must be >= 1, got {calibration_bins!r}")

    def _fresh_bucket() -> dict[str, Any]:
        return {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "n": 0, "correct": 0,
                "conf_correct": [], "conf_wrong": [], "top_pairs": [], "tp_pairs": [], "decision_pairs": [],
                "n_human": 0, "n_human_escalated": 0, "n_outcome": 0,
                "n_anchor_external": 0, "n_anchor_self_excluded": 0,
                "n_prior_version": 0,
                "w_tp": 0.0, "w_fp": 0.0, "w_fn": 0.0}

    # J2 — the ledger is append-ordered, so the last verdict a judge gave
    # names its current version.
    current_version: dict[str, tuple[str, str]] = {
        str(row.get("judge_id")): _judge_version(row)
        for row in rows
        if row.get("source_type") == "ai_judge" and row.get("judge_id")
    }
    prior_versions: dict[str, set[tuple[str, str]]] = {}
    agg: dict[str, dict[str, Any]] = {}
    by_source: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        judge_id = str(row.get("judge_id") or "")
        judge_verdict = str(row.get("verdict") or "")
        if not judge_id or not judge_verdict:
            continue
        found = truth.get(_group_key(row))
        if found is None:
            continue
        truth_verdict, truth_source, observers, weight = found
        bucket = agg.setdefault(judge_id, _fresh_bucket())
        if _judge_version(row) != current_version[judge_id]:
            bucket["n_prior_version"] += 1
            prior_versions.setdefault(judge_id, set()).add(_judge_version(row))
            continue
        if truth_source == "ai_consensus" and judge_id in observers:
            # ARIA-HIGH-173 — an anchor this judge helped form is its own
            # vote wearing a consensus hat: counted, never scored.
            bucket["n_anchor_self_excluded"] += 1
            continue
        bucket[
            {"human": "n_human", "human_escalated": "n_human_escalated",
             "outcome": "n_outcome"}.get(truth_source, "n_anchor_external")
        ] += 1
        source_bucket = by_source.setdefault(
            (judge_id, str(row.get("model") or ""), str(row.get("confidence_source") or "self_reported")),
            _fresh_bucket(),
        )
        for b in (bucket, source_bucket):
            b["n"] += 1
            correct = judge_verdict == truth_verdict
            if correct:
                b["correct"] += 1
            if truth_verdict == "true_positive":
                if judge_verdict == "true_positive":
                    b["tp"] += 1
                    b["w_tp"] += weight
                else:
                    b["fn"] += 1
                    b["w_fn"] += weight
            else:  # truth false_positive
                if judge_verdict == "true_positive":
                    b["fp"] += 1
                    b["w_fp"] += weight
                else:
                    b["tn"] += 1
            conf = row.get("confidence")
            if isinstance(conf, (int, float)) and not isinstance(conf, bool):
                confidence = float(conf)
                b["conf_correct" if correct else "conf_wrong"].append(confidence)
                # Typed-judgment plan — two events, one number: the verdict
                # is right (top-label, the 0.80 gate's quantity) and the
                # finding is a true positive (the precision lane's).
                b["top_pairs"].append((confidence, correct))
                if truth_source != "human_escalated":
                    # The decision is taken over the random strata and the
                    # external anchors; escalated labels are the hard cases
                    # (review C3) and are reported, never decided on.
                    b["decision_pairs"].append((confidence, correct))
                p_tp = confidence if judge_verdict == "true_positive" else 1.0 - confidence
                b["tp_pairs"].append((p_tp, truth_verdict == "true_positive"))

    def _scored(judge_id: str, b: dict[str, Any], *, seed_parts: tuple[str, ...]) -> dict[str, Any]:
        top_pairs: list[tuple[float, bool]] = b["decision_pairs"]
        ece = expected_calibration_error(top_pairs, bins=calibration_bins)
        # The bootstrap is the decision's cost, paid only where a decision is
        # possible: under the provisional floor the status is fixed anyway.
        ece_upper = (
            bootstrap_ece_upper(top_pairs, bins=calibration_bins,
                                seed=deterministic_seed("judge-calibration", *seed_parts))
            if len(top_pairs) >= provisional_min_samples else None
        )
        high = [(p, hit) for p, hit in top_pairs if p >= high_confidence_floor]
        high_lower = wilson_lower(sum(1 for _p, hit in high if hit), len(high))
        status = calibration_status(
            samples_with_confidence=len(top_pairs), ece_upper=ece_upper,
            high_confidence_accuracy_lower=high_lower, high_confidence_trials=len(high),
            calibration_min_samples=calibration_min_samples, provisional_min_samples=provisional_min_samples,
            ece_threshold=ece_threshold, high_confidence_accuracy_min=high_confidence_accuracy_min,
        )
        return {
            "samples_with_confidence": len(top_pairs),
            "samples_with_confidence_all_strata": len(b["top_pairs"]),
            "brier_top": brier_score(top_pairs), "brier_skill": brier_skill_score(top_pairs),
            "brier_tp": brier_score(b["tp_pairs"]),
            "ece_top": ece["ece"], "ece_bins": ece["bins"], "ece_upper_90": ece_upper,
            "high_confidence_trials": len(high), "high_confidence_accuracy_lower": high_lower,
            "calibration_status": status,
        }

    judges: list[dict[str, Any]] = []
    degraded: list[str] = []
    for judge_id, b in sorted(agg.items()):
        precision = round(b["tp"] / max(b["tp"] + b["fp"], 1), 3)
        recall = round(b["tp"] / max(b["tp"] + b["fn"], 1), 3)
        accuracy = round(b["correct"] / max(b["n"], 1), 3)
        # ARIA-LOW-608 — the Horvitz-Thompson ratio estimates. With no
        # stratified labels every weight is 1 and they equal the unweighted
        # counts, so the pre-608 semantics are the π=1 special case.
        w_tp_denom = b["w_tp"] + b["w_fp"]
        w_rec_denom = b["w_tp"] + b["w_fn"]
        precision_ht = round(b["w_tp"] / w_tp_denom, 3) if w_tp_denom > 0 else 0.0
        recall_ht = round(b["w_tp"] / w_rec_denom, 3) if w_rec_denom > 0 else 0.0
        if b["n"] < min_samples:
            status = "insufficient_data"
        elif precision_ht < precision_floor:
            status = "degraded"
        else:
            status = "ok"
        if status == "degraded":
            degraded.append(judge_id)
        judges.append({
            "judge_id": judge_id,
            "samples": b["n"],
            "weighting": "horvitz_thompson",
            "precision": precision,
            "recall": recall,
            "precision_ht": precision_ht,
            "recall_ht": recall_ht,
            "accuracy": accuracy,
            "true_positive": b["tp"],
            "false_positive": b["fp"],
            "false_negative": b["fn"],
            "true_negative": b["tn"],
            "mean_confidence_correct": _mean(b["conf_correct"]),
            "mean_confidence_wrong": _mean(b["conf_wrong"]),
            "status": status,
            "version": {"model": current_version[judge_id][0] or None,
                        "agent_contract_hash": current_version[judge_id][1] or None},
            "prior_version": {"samples": b["n_prior_version"],
                              "versions": len(prior_versions.get(judge_id, ()))},
            "ground_truth_strata": {"n_human": b["n_human"], "n_human_escalated": b["n_human_escalated"],
                                    "n_outcome": b["n_outcome"],
                                    "n_anchor_external": b["n_anchor_external"],
                                    "n_anchor_self_excluded": b["n_anchor_self_excluded"]},
            **_scored(judge_id, b, seed_parts=(judge_id,)),
            "by_source": [
                {"model": model, "confidence_source": source, "samples": sb["n"],
                 **_scored(judge_id, sb, seed_parts=(judge_id, model, source))}
                for (jid, model, source), sb in sorted(by_source.items()) if jid == judge_id
            ],
        })

    result = {
        "schema_version": 2,
        "calibration_thresholds": {
            "calibration_min_samples": calibration_min_samples, "provisional_min_samples": provisional_min_samples,
            "ece_threshold": ece_threshold, "high_confidence_floor": high_confidence_floor,
            "high_confidence_accuracy_min": high_confidence_accuracy_min, "calibration_bins": calibration_bins,
        },
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "min_samples": min_samples,
        "precision_floor": precision_floor,
        "judged_judges": len(judges),
        "degraded_judges": degraded,
        "unverified_ground_truth_rows": len(unverified_rows),
        "judges": judges,
    }
    return result


def compute_judge_calibration(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    precision_floor: float = DEFAULT_PRECISION_FLOOR,
    judgment_group_prefix: str | None = None,
    target_sha: str | None = None,
    **calibration_knobs: Any,
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth and persist a row.

    Thin persistence owner over `score_judges` (see its docstring for the
    scoring semantics): the calibration phase appends exactly this row, and
    every consumer that needs the CURRENT calibration calls `score_judges`
    directly instead of reading this ledger's tail — the tail is audit
    history, not a freshness source (ORPHAN-HIGH-784).

    ARIA-HIGH-004 — the row is a calibration REPORT the learning funnel can
    join: it carries its own id, the commit of the cycle that measured it
    (``target_sha`` from the caller's envelope; None when the caller names
    none) and the judgment-group prefix it was scored over, so an organic
    report is never read for a gold-set replay one.
    """
    if target_sha is not None and not is_object_id(target_sha, formats=ANY_OBJECT_FORMAT):
        raise GovernanceError("judge calibration target_sha must be a full git object id")
    result = score_judges(
        cycle_id=cycle_id,
        base_dir=base_dir,
        min_samples=min_samples,
        precision_floor=precision_floor,
        judgment_group_prefix=judgment_group_prefix,
        **calibration_knobs,
    )
    result = {
        **result,
        "calibration_report_id": f"jcal-{uuid.uuid4().hex[:24]}",
        "target_sha": target_sha,
        "judgment_group_prefix": judgment_group_prefix,
    }
    path = calibration_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, result)
    return result
