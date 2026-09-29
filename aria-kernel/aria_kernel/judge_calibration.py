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

from pathlib import Path
from typing import Any

from .feedback_store import append_jsonl, is_ground_truth_row, load_feedback
from .tool_registry import ensure_tools_dir, utc_now


DEFAULT_MIN_SAMPLES: int = 10
DEFAULT_PRECISION_FLOOR: float = 0.7
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


def _build_ground_truth(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], str]:
    """Best ground-truth verdict per finding. human beats ai_consensus."""
    truth: dict[tuple[str, str, str], tuple[str, str]] = {}
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
        # Feedback is append-only; an operator can correct an earlier call with a
        # later row. Last-write-wins within precedence: a later `human` always
        # overrides, a later `ai_consensus` overrides only when no `human` exists.
        if existing is None:
            truth[key] = (verdict, source)
        elif source == "human":
            truth[key] = (verdict, source)
        elif source == "ai_consensus" and existing[1] != "human":
            truth[key] = (verdict, source)
    return {key: verdict for key, (verdict, _src) in truth.items()}


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def compute_judge_calibration(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    precision_floor: float = DEFAULT_PRECISION_FLOOR,
    judgment_group_prefix: str | None = None,
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth and persist a row.

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
    truth = _build_ground_truth(rows)

    agg: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("source_type") != "ai_judge":
            continue
        judge_id = str(row.get("judge_id") or "")
        judge_verdict = str(row.get("verdict") or "")
        if not judge_id or not judge_verdict:
            continue
        truth_verdict = truth.get(_group_key(row))
        if truth_verdict is None:
            continue
        bucket = agg.setdefault(
            judge_id,
            {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "n": 0, "correct": 0,
             "conf_correct": [], "conf_wrong": []},
        )
        bucket["n"] += 1
        correct = judge_verdict == truth_verdict
        if correct:
            bucket["correct"] += 1
        if truth_verdict == "true_positive":
            bucket["tp" if judge_verdict == "true_positive" else "fn"] += 1
        else:  # truth false_positive
            bucket["fp" if judge_verdict == "true_positive" else "tn"] += 1
        conf = row.get("confidence")
        if isinstance(conf, (int, float)):
            bucket["conf_correct" if correct else "conf_wrong"].append(float(conf))

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
        })

    result = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "min_samples": min_samples,
        "precision_floor": precision_floor,
        "judged_judges": len(judges),
        "degraded_judges": degraded,
        "judges": judges,
    }
    path = calibration_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, result)
    return result
