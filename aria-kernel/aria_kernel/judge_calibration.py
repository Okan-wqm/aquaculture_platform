"""Plan 024 §A — closed-loop judge calibration.

ARIA's trust rests on the judge → consensus chain, yet nothing measured whether
the judges are right. ``tool_health.compute_metrics`` scores the ADAPTER
(``tool_health.py`` precision), and a full grep shows no ``judge_id``-keyed
precision anywhere. This module fills that gap WITHOUT re-invoking any LLM: it
joins every ``ai_judge`` verdict to the ground-truth verdict on the same finding
and scores each ``judge_id`` over the accumulated feedback ledger.

Ground truth for a judge = a ``human`` or ``ai_consensus`` feedback row on the
same ``(run_id, finding_id, judgment_group_id)`` the judge also voted on — the
exact join ``generate_ai_consensus`` already uses to form consensus. ``human``
outranks ``ai_consensus`` when both exist.

Cheap by construction: precision / recall / calibration come from verdicts and
confidences ALREADY recorded. NOTE on recall: this is recall over *surfaced*
findings only (the judge voted, and a ground truth exists). True
gold-set-replay recall — re-invoking judges on known findings they never saw —
needs LLM re-invocation and is deferred to Plan 025 (ARIA-024-D1).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import append_jsonl, load_feedback
from .tool_registry import ensure_tools_dir, utc_now


GROUND_TRUTH_SOURCES: tuple[str, ...] = ("human", "ai_consensus")
DEFAULT_MIN_SAMPLES: int = 10
DEFAULT_PRECISION_FLOOR: float = 0.7


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
        source = row.get("source_type")
        if source not in GROUND_TRUTH_SOURCES:
            continue
        verdict = str(row.get("verdict") or "")
        if not verdict:
            continue
        key = _group_key(row)
        existing = truth.get(key)
        if existing is None or (source == "human" and existing[1] != "human"):
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
) -> dict[str, Any]:
    """Score every judge_id against accumulated ground truth and persist a row.

    Positive class = ``true_positive``. Per judge: precision, recall, accuracy,
    and a calibration signal (mean confidence on correct vs wrong calls). A
    judge with >= ``min_samples`` ground-truth-backed verdicts whose precision
    drops below ``precision_floor`` is reported ``degraded`` — the operator-
    visible, detectable signal that the cheap-tier judgment is slipping.
    """
    rows = load_feedback(base_dir=base_dir)
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
