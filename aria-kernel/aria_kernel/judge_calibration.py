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
from pathlib import Path
from typing import Any

from .calibrated_intelligence import deterministic_seed
from .feedback_store import append_jsonl, is_ground_truth_row, load_feedback
from .tool_registry import ensure_tools_dir, utc_now


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
# Organic calibration must exclude gold-set replay verdicts that live under this
# group, or a judge's everyday precision/recall is corrupted by its replay run.
_REPLAY_GROUP_PREFIX: str = "replay:"


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


def _build_ground_truth_detail(
    rows: list[dict[str, Any]],
) -> dict[tuple[str, str, str], tuple[str, str, frozenset[str]]]:
    """Best ground-truth ``(verdict, source, observers)`` per finding.
    human beats ai_consensus; an anchor row remembers who formed it."""
    truth: dict[tuple[str, str, str], tuple[str, str, frozenset[str]]] = {}
    for row in rows:
        # JJ-1 — one predicate, five readers (see feedback_store).
        if not is_ground_truth_row(row):
            continue
        source = row.get("source_type") or "human"
        verdict = str(row.get("verdict") or "")
        if not verdict:
            continue
        key = _group_key(row)
        existing = truth.get(key)
        observers = _observer_ids(row) if source == "ai_consensus" else frozenset()
        # Feedback is append-only; an operator can correct an earlier call with a
        # later row. Last-write-wins within precedence: a later `human` always
        # overrides, a later `ai_consensus` overrides only when no `human` exists.
        if existing is None:
            truth[key] = (verdict, source, observers)
        elif source == "human":
            truth[key] = (verdict, source, observers)
        elif source == "ai_consensus" and existing[1] != "human":
            truth[key] = (verdict, source, observers)
    return truth


def _build_ground_truth(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], str]:
    """Best ground-truth verdict per finding. human beats ai_consensus."""
    return {key: verdict for key, (verdict, _src, _obs) in _build_ground_truth_detail(rows).items()}


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
    """Confidences of the consensus rows a HUMAN later agreed with — the
    only rows a conformal floor may be taken over (ARIA-HIGH-173: the floor
    used to be the 10th percentile of every consensus output, correct or
    not)."""
    human: dict[tuple[str, str, str], str] = {}
    for row in rows:
        if (row.get("source_type") or "human") == "human" and row.get("verdict"):
            human[_group_key(row)] = str(row["verdict"])
    out: list[float] = []
    for row in rows:
        if row.get("source_type") != "ai_consensus" or not isinstance(row.get("confidence"), (int, float)):
            continue
        truth = human.get(_group_key(row))
        if truth is not None and truth == str(row.get("verdict") or ""):
            out.append(float(row["confidence"]))
    return out


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


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
    and a calibration signal (mean confidence on correct vs wrong calls). A
    judge with >= ``min_samples`` ground-truth-backed verdicts whose precision
    drops below ``precision_floor`` is reported ``degraded`` — the operator-
    visible, detectable signal that the cheap-tier judgment is slipping.

    ``judgment_group_prefix`` isolates a subset of verdicts by their
    ``judgment_group_id`` — Plan 025 §C passes ``"replay:"`` to score the
    gold-set replay independently from organic surfaced verdicts.
    """
    rows = load_feedback(base_dir=base_dir)
    if judgment_group_prefix is not None:
        rows = [
            r for r in rows
            if str(r.get("judgment_group_id") or "").startswith(judgment_group_prefix)
        ]
    else:
        # Organic calibration excludes gold-set replay verdicts (Plan 025 §C),
        # which live under the 'replay:' group — folding them into a judge's
        # everyday buckets corrupts its precision/recall and the degraded signal
        # that proactive prioritization + the operator report consume.
        rows = [
            r for r in rows
            if not str(r.get("judgment_group_id") or "").startswith(_REPLAY_GROUP_PREFIX)
        ]
    truth = _build_ground_truth_detail(rows)
    if calibration_bins < 1:
        raise ValueError(f"calibration_bins must be >= 1, got {calibration_bins!r}")

    def _fresh_bucket() -> dict[str, Any]:
        return {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "n": 0, "correct": 0,
                "conf_correct": [], "conf_wrong": [], "top_pairs": [], "tp_pairs": [],
                "n_human": 0, "n_anchor_external": 0, "n_anchor_self_excluded": 0}

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
        truth_verdict, truth_source, observers = found
        bucket = agg.setdefault(judge_id, _fresh_bucket())
        if truth_source == "ai_consensus" and judge_id in observers:
            # ARIA-HIGH-173 — an anchor this judge helped form is its own
            # vote wearing a consensus hat: counted, never scored.
            bucket["n_anchor_self_excluded"] += 1
            continue
        bucket["n_human" if truth_source == "human" else "n_anchor_external"] += 1
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
                b["tp" if judge_verdict == "true_positive" else "fn"] += 1
            else:  # truth false_positive
                b["fp" if judge_verdict == "true_positive" else "tn"] += 1
            conf = row.get("confidence")
            if isinstance(conf, (int, float)) and not isinstance(conf, bool):
                confidence = float(conf)
                b["conf_correct" if correct else "conf_wrong"].append(confidence)
                # Typed-judgment plan — two events, one number: the verdict
                # is right (top-label, the 0.80 gate's quantity) and the
                # finding is a true positive (the precision lane's).
                b["top_pairs"].append((confidence, correct))
                p_tp = confidence if judge_verdict == "true_positive" else 1.0 - confidence
                b["tp_pairs"].append((p_tp, truth_verdict == "true_positive"))

    def _scored(judge_id: str, b: dict[str, Any], *, seed_parts: tuple[str, ...]) -> dict[str, Any]:
        top_pairs: list[tuple[float, bool]] = b["top_pairs"]
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
        if b["n"] < min_samples:
            status = "insufficient_data"
        elif precision < precision_floor:
            status = "degraded"
        else:
            status = "ok"
        if status == "degraded":
            degraded.append(judge_id)
        judges.append({
            "judge_id": judge_id,
            "samples": b["n"],
            "precision": precision,
            "recall": recall,
            "accuracy": accuracy,
            "true_positive": b["tp"],
            "false_positive": b["fp"],
            "false_negative": b["fn"],
            "true_negative": b["tn"],
            "mean_confidence_correct": _mean(b["conf_correct"]),
            "mean_confidence_wrong": _mean(b["conf_wrong"]),
            "status": status,
            "ground_truth_strata": {"n_human": b["n_human"], "n_anchor_external": b["n_anchor_external"],
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
    **calibration_knobs: Any,
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth and persist a row.

    Thin persistence owner over `score_judges` (see its docstring for the
    scoring semantics): the calibration phase appends exactly this row, and
    every consumer that needs the CURRENT calibration calls `score_judges`
    directly instead of reading this ledger's tail — the tail is audit
    history, not a freshness source (ORPHAN-HIGH-784).
    """
    result = score_judges(
        cycle_id=cycle_id,
        base_dir=base_dir,
        min_samples=min_samples,
        precision_floor=precision_floor,
        judgment_group_prefix=judgment_group_prefix,
        **calibration_knobs,
    )
    path = calibration_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, result)
    return result
