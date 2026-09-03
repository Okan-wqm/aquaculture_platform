from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


def record_performance_baseline(
    *,
    metric: str,
    value: float,
    unit: str,
    source: str,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not metric.strip() or not unit.strip() or not source.strip():
        raise GovernanceError("performance metric, unit and source are required")
    if value < 0:
        raise GovernanceError("performance value must be non-negative")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "metric": metric,
        "value": value,
        "unit": unit,
        "source": source,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "performance" / "baselines.jsonl",
        row,
        expected_surface="performance_baselines",
    )


def compare_performance_baseline(
    *,
    metric: str,
    current_value: float,
    max_regression_pct: float = 5.0,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if current_value < 0:
        raise GovernanceError("current performance value must be non-negative")
    baseline = _latest_baseline(metric=metric, base_dir=base_dir)
    if baseline is None:
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "metric": metric,
            "status": "missing_baseline",
            "current_value": current_value,
            "baseline_value": None,
            "regression_pct": None,
        }
    else:
        baseline_value = float(baseline["value"])
        regression_pct = 0.0 if baseline_value == 0 else ((current_value - baseline_value) / baseline_value) * 100
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "metric": metric,
            "status": "regression" if regression_pct > max_regression_pct else "ok",
            "current_value": current_value,
            "baseline_value": baseline_value,
            "regression_pct": round(regression_pct, 3),
            "max_regression_pct": max_regression_pct,
            "baseline_ref": baseline.get("ledger_hash"),
        }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "performance" / "comparisons.jsonl",
        row,
        expected_surface="performance_comparisons",
    )


def list_performance_baselines(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "performance" / "baselines.jsonl",
        expected_surface="performance_baselines",
    )


def list_performance_comparisons(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "performance" / "comparisons.jsonl",
        expected_surface="performance_comparisons",
    )


def _latest_baseline(*, metric: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(list_performance_baselines(base_dir=base_dir)):
        if row.get("metric") == metric:
            return row
    return None
