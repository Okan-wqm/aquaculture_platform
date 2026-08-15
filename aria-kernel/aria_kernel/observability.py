from __future__ import annotations

from pathlib import Path
from statistics import median
from typing import Any

from .budget import list_budget_usage
from .ledger import append_declared_jsonl, load_jsonl
from .runtime_artifacts import artifact_inventory_path
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation_runs_ledger import (
    classify_validation_run_status,
    list_validation_runs,
    validation_run_duration_ms,
)


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
    if status not in ("ok", "failed", "blocked", "partial", "degraded", "integrity_failed"):
        raise GovernanceError("cycle metrics status must be ok, failed, blocked, partial, degraded, or integrity_failed")
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
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "observability" / "cycle-metrics.jsonl", row, expected_surface="observability_cycle_metrics")


def generate_observability_dashboard(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    metrics = list_cycle_metrics(base_dir=base_dir)
    validation_runs = list_validation_runs(base_dir=base_dir)
    budget_usage = list_budget_usage(base_dir=base_dir)
    latest = metrics[-1] if metrics else None
    rolling = _rolling_slo(metrics)
    alerts = _record_alerts(cycle_id=cycle_id, metrics=metrics, rolling=rolling, base_dir=base_dir)
    artifact_inventory = load_jsonl(artifact_inventory_path(base_dir))
    dashboard = {
        "schema_version": 2,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "latest_cycle": latest,
        "trend": _metrics_trend(metrics),
        "rolling_slo": rolling,
        "alerts": alerts,
        "artifact_bytes_by_class": _artifact_bytes_by_class(artifact_inventory),
        "operator_message": _operator_message(metrics),
        # E21-a — read the unified fields, do not infer them. The
        # pre-E21-a expression `run.get("status") not in ("ok",)` counted
        # every row written by validation_runs_ledger as FAILED, because
        # that writer's schema carried no `status` key at all, and summed
        # `duration_ms or 0` over rows that carried no duration. With one
        # writer stamping both fields, the readers below refuse a row that
        # lacks them rather than silently miscounting it.
        "validation": _validation_summary(validation_runs),
        "cost": {
            "usage_count": len(budget_usage),
            "estimated_usd": round(sum(float(row.get("estimated_usd") or 0.0) for row in budget_usage), 4),
        },
        "status": "reported",
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "observability" / "dashboards.jsonl", dashboard, expected_surface="observability_dashboards")


def _validation_summary(validation_runs: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = [classify_validation_run_status(run) for run in validation_runs]
    return {
        "run_count": len(validation_runs),
        "failed_count": sum(1 for status in statuses if status != "ok"),
        "status_counts": {
            status: statuses.count(status) for status in sorted(set(statuses))
        },
        "total_duration_ms": sum(
            validation_run_duration_ms(run) for run in validation_runs
        ),
    }


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


def alerts_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "observability" / "alerts.jsonl"


def _rolling_slo(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    window = metrics[-30:]
    durations = [int(row.get("total_duration_ms") or 0) for row in window]
    if not durations:
        return {"window": 0, "slo_state": "ok", "duration_p50_ms": 0, "duration_p95_ms": 0}
    sorted_durations = sorted(durations)
    p50 = int(median(sorted_durations))
    p95_index = min(len(sorted_durations) - 1, int(round((len(sorted_durations) - 1) * 0.95)))
    p95 = sorted_durations[p95_index]
    latest = durations[-1]
    if latest > 900_000 or (p50 and latest > 2 * p50):
        state = "degraded"
    elif latest > 600_000 or (p50 and latest > int(1.5 * p50)):
        state = "warning"
    else:
        state = "ok"
    return {
        "window": len(window),
        "slo_state": state,
        "duration_p50_ms": p50,
        "duration_p95_ms": p95,
        "latest_duration_ms": latest,
    }


def _record_alerts(
    *,
    cycle_id: str,
    metrics: list[dict[str, Any]],
    rolling: dict[str, Any],
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    if rolling.get("slo_state") in {"warning", "degraded"}:
        alerts.append({
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "slo_state": rolling.get("slo_state"),
            "reason": "cycle_duration_slo",
            "threshold": "warning>600s_or_1.5x_p50 degraded>900s_or_2x_p50",
            "observed": rolling.get("latest_duration_ms"),
        })
    if len(metrics) >= 2:
        previous = metrics[-2]
        latest = metrics[-1]
        prev_artifacts = int(previous.get("artifact_count") or 0)
        latest_artifacts = int(latest.get("artifact_count") or 0)
        if prev_artifacts > 0 and latest_artifacts == 0:
            alerts.append({
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "slo_state": "degraded",
                "reason": "artifact_count_cliff",
                "threshold": "previous_artifact_count>0 latest_artifact_count=0",
                "observed": latest_artifacts,
            })
    for alert in alerts:
        append_declared_jsonl(alerts_path(base_dir), alert, expected_surface="observability_alerts")
    return alerts


def _artifact_bytes_by_class(rows: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for row in rows:
        klass = str(row.get("artifact_class") or "unknown")
        totals[klass] = totals.get(klass, 0) + int(row.get("bytes") or 0)
    return dict(sorted(totals.items()))
