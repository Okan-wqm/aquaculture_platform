from __future__ import annotations

from pathlib import Path
from typing import Any

from .budget import list_budget_usage
from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import list_validation_runs


def record_cycle_metrics(
    *,
    cycle_id: str,
    phase_durations_ms: dict[str, int | float],
    artifact_count: int,
    status: str,
    cost_units: float = 0.0,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not cycle_id.strip():
        raise GovernanceError("cycle metrics require cycle_id")
    if status not in ("ok", "failed", "blocked", "partial"):
        raise GovernanceError("cycle metrics status must be ok, failed, blocked, or partial")
    if artifact_count < 0 or cost_units < 0:
        raise GovernanceError("cycle metrics counts must be non-negative")
    durations = _normalize_durations(phase_durations_ms)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "status": status,
        "phase_durations_ms": durations,
        "total_duration_ms": int(sum(durations.values())),
        "artifact_count": artifact_count,
        "cost_units": cost_units,
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "observability" / "cycle-metrics.jsonl", row)


def generate_observability_dashboard(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    metrics = list_cycle_metrics(base_dir=base_dir)
    validation_runs = list_validation_runs(base_dir=base_dir)
    budget_usage = list_budget_usage(base_dir=base_dir)
    latest = metrics[-1] if metrics else None
    dashboard = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "latest_cycle": latest,
        "trend": _metrics_trend(metrics),
        "operator_message": _operator_message(metrics),
        "validation": {
            "run_count": len(validation_runs),
            "failed_count": sum(1 for run in validation_runs if run.get("status") not in ("ok",)),
            "total_duration_ms": sum(int(run.get("duration_ms") or 0) for run in validation_runs),
        },
        "cost": {
            "usage_count": len(budget_usage),
            "estimated_usd": round(sum(float(row.get("estimated_usd") or 0.0) for row in budget_usage), 4),
        },
        "status": "reported",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "observability" / "dashboards.jsonl", dashboard)


def list_cycle_metrics(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "observability" / "cycle-metrics.jsonl")


def list_observability_dashboards(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "observability" / "dashboards.jsonl")


def _normalize_durations(durations: dict[str, int | float]) -> dict[str, int]:
    if not isinstance(durations, dict) or not durations:
        raise GovernanceError("phase_durations_ms must be a non-empty object")
    normalized = {}
    for key, value in durations.items():
        if not isinstance(key, str) or not key.strip():
            raise GovernanceError("phase duration keys must be non-empty strings")
        if not isinstance(value, (int, float)) or value < 0:
            raise GovernanceError("phase durations must be non-negative numbers")
        normalized[key] = int(round(value))
    return dict(sorted(normalized.items()))


def _metrics_trend(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    if len(metrics) < 2:
        return {"window": len(metrics), "duration_delta_ms": 0, "cost_units_delta": 0.0}
    previous = metrics[-2]
    latest = metrics[-1]
    return {
        "window": min(len(metrics), 30),
        "duration_delta_ms": int(latest.get("total_duration_ms") or 0) - int(previous.get("total_duration_ms") or 0),
        "cost_units_delta": round(float(latest.get("cost_units") or 0.0) - float(previous.get("cost_units") or 0.0), 3),
    }


def _operator_message(metrics: list[dict[str, Any]]) -> str:
    if not metrics:
        return "insufficient_history: no recorded cycle metrics yet"
    if len(metrics) == 1:
        return "insufficient_history: trend will be available after the next recorded cycle"
    return "trend_available"
