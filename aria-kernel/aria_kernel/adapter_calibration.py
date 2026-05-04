from __future__ import annotations

from pathlib import Path
from typing import Any

from .fixture_runner import latest_fixture_pass
from .ledger import append_jsonl, load_jsonl as load_chained_jsonl
from .promotion import is_clean_shadow_run
from .tool_health import compute_metrics, load_jsonl, runs_path
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, utc_now


def generate_adapter_calibration_report(
    *,
    tool_ids: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if not tool_ids or not all(isinstance(tool_id, str) and tool_id.strip() for tool_id in tool_ids):
        raise GovernanceError("adapter calibration report requires tool_ids")
    reports = [_tool_report(tool_id.strip(), base_dir) for tool_id in tool_ids]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "tool_ids": [report["tool_id"] for report in reports],
        "reports": reports,
        "active_ready_count": sum(1 for report in reports if report["active_ready"]),
        "blocked_count": sum(1 for report in reports if not report["active_ready"]),
        "status": "active_ready" if all(report["active_ready"] for report in reports) else "blocked",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "calibration" / "adapter-calibration-reports.jsonl", row)


def list_adapter_calibration_reports(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_chained_jsonl(ensure_tools_dir(base_dir) / "calibration" / "adapter-calibration-reports.jsonl")


def _tool_report(tool_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    if tool.get("kind") != "adapter":
        raise GovernanceError(f"tool is not an adapter: {tool_id}")
    runs = load_jsonl(runs_path(base_dir), tool_id=tool_id)
    metrics = compute_metrics(tool, runs, base_dir=base_dir)
    latest_runs = runs[-5:]
    fixture_pass = latest_fixture_pass(tool_id, base_dir=base_dir)
    clean_shadow_runs = sum(1 for run in latest_runs if is_clean_shadow_run(run))
    precision = float(metrics.get("precision", 0.0))
    precision_min = float(tool.get("health_thresholds", {}).get("precision_min", 0.85))
    blockers = []
    if tool.get("status") != "SHADOW":
        blockers.append("tool_not_shadow")
    if not fixture_pass:
        blockers.append("latest_fixture_not_passed")
    if len(latest_runs) < 5:
        blockers.append("fewer_than_5_shadow_runs")
    if clean_shadow_runs < 5:
        blockers.append("last_5_runs_not_clean")
    if precision < precision_min:
        blockers.append("precision_below_threshold")
    if int(metrics.get("critical_false_positives", 0)) > 0:
        blockers.append("critical_false_positive_present")
    return {
        "tool_id": tool_id,
        "status": tool.get("status"),
        "fixture_pass": fixture_pass,
        "run_count": len(runs),
        "clean_shadow_runs_last_5": clean_shadow_runs,
        "precision": precision,
        "precision_min": precision_min,
        "critical_false_positives": int(metrics.get("critical_false_positives", 0)),
        "active_ready": not blockers,
        "blocked_by": blockers,
    }
