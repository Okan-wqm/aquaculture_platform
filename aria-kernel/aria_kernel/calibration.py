from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import load_feedback
from .ledger import append_jsonl, load_jsonl
from .runs_reader import read_runs_rows
from .tool_health import compute_metrics, runs_path
from .tool_registry import ensure_tools_dir, list_tools, utc_now


# The weight SSoT is pressure.SOURCE_WEIGHTS — the table scoring actually
# uses. This module used to keep a private copy that had silently drifted
# (evidence_gone 65 here vs 80 live), so its recommendations referenced
# numbers nothing consumed. Recommendations now read the operator-EFFECTIVE
# table, and record_weight_override (pressure.py) is the consumer that turns
# an approved recommendation into behaviour.
from .pressure import effective_source_weights as _effective_source_weights


def recommend_calibration(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    feedback_rows = load_feedback(base_dir=base_dir)
    runs = list(read_runs_rows(runs_path(root), base_dir=root))
    tool_recommendations = []
    for tool in list_tools(base_dir=base_dir):
        tool_runs = [run for run in runs if run.get("tool_id") == tool.get("tool_id")]
        metrics = compute_metrics(tool, tool_runs, base_dir=base_dir)
        recommendation = _tool_recommendation(tool["tool_id"], metrics)
        if recommendation:
            tool_recommendations.append(recommendation)
    pressure_weights = _pressure_weight_recommendations(feedback_rows, base_dir=root)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "tool_recommendations": tool_recommendations,
        "pressure_weight_recommendations": pressure_weights,
        "status": "recommendation_only",
    }
    return append_jsonl(root / "calibration" / "recommendations.jsonl", row)


def list_calibration_recommendations(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "calibration" / "recommendations.jsonl")


def _tool_recommendation(tool_id: str, metrics: dict[str, Any]) -> dict[str, Any] | None:
    reasons = []
    if float(metrics.get("precision", 1.0)) < 0.85 and int(metrics.get("judged_samples", 0)) > 0:
        reasons.append("precision_below_target")
    if int(metrics.get("budget_exceeded_7d", 0)) > 0:
        reasons.append("budget_exceeded_recently")
    if float(metrics.get("crash_rate_last_10", 0.0)) > 0.2:
        reasons.append("crash_rate_above_target")
    if not reasons:
        return None
    return {
        "tool_id": tool_id,
        "action": "review_thresholds",
        "reasons": reasons,
        "metrics": metrics,
    }


def _pressure_weight_recommendations(feedback_rows: list[dict[str, Any]], *, base_dir=None) -> list[dict[str, Any]]:
    by_kind: dict[str, dict[str, int]] = {}
    for row in feedback_rows:
        kind = str(row.get("metadata", {}).get("pressure_source") or row.get("tool_id") or "unknown")
        verdict = str(row.get("verdict") or row.get("kind") or "")
        bucket = by_kind.setdefault(kind, {"tp": 0, "fp": 0})
        if verdict == "true_positive":
            bucket["tp"] += 1
        elif verdict == "false_positive":
            bucket["fp"] += 1
    recommendations = []
    for kind, counts in sorted(by_kind.items()):
        total = counts["tp"] + counts["fp"]
        if total < 2:
            continue
        current = _effective_source_weights(base_dir).get(kind, 50)
        precision = counts["tp"] / total
        if precision >= 0.85:
            recommended = min(100, current + 5)
        elif precision <= 0.5:
            recommended = max(10, current - 10)
        else:
            continue
        recommendations.append(
            {
                "source": kind,
                "current_weight": current,
                "recommended_weight": recommended,
                "feedback_precision": round(precision, 3),
                "sample_count": total,
            },
        )
    return recommendations
