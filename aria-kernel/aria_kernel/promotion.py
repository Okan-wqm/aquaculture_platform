from __future__ import annotations

from pathlib import Path
from typing import Any

from .fixture_runner import latest_fixture_status
from .tool_health import compute_metrics, load_jsonl, runs_path
from .tool_registry import GovernanceError, get_tool, transition_tool


def promote_tool(
    tool_id: str,
    target_status: str,
    *,
    reason: str,
    operator_approval_ref: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    fixture_status = latest_fixture_status(tool_id, base_dir=base_dir)
    fixture_passed = fixture_status["current_tool_passed"]
    if target_status == "SHADOW" and tool["status"] == "CALIBRATE" and not fixture_passed:
        raise GovernanceError("CALIBRATE -> SHADOW requires the latest fixture suite to pass for the current tool version and manifest hash")
    if target_status == "ACTIVE":
        if not fixture_passed:
            raise GovernanceError("SHADOW -> ACTIVE requires the latest fixture suite to pass for the current tool version and manifest hash")
        if not operator_approval_ref:
            raise GovernanceError("SHADOW -> ACTIVE requires operator approval ref")
        runs = load_jsonl(runs_path(base_dir), tool_id=tool_id)
        if len(runs) < 5 or not all(is_clean_shadow_run(run) for run in runs[-5:]):
            raise GovernanceError("SHADOW -> ACTIVE requires 5 consecutive clean shadow runs")
        metrics = compute_metrics(tool, runs, base_dir=base_dir)
        if metrics.get("precision_status") != "judged":
            raise GovernanceError("SHADOW -> ACTIVE requires operator-judged precision samples")
        return transition_tool(
            tool_id,
            target_status,
            reason=reason,
            base_dir=base_dir,
            operator_approval=True,
            precision=metrics["precision"],
            critical_false_positives=metrics["critical_false_positives"],
            evidence_chains_valid=True,
        )
    return transition_tool(
        tool_id,
        target_status,
        reason=reason,
        base_dir=base_dir,
        fixture_suite_passed=fixture_passed,
    )


def is_clean_shadow_run(run: dict[str, Any]) -> bool:
    if run.get("status") != "ok":
        return False
    validation = run.get("evidence_validation", {})
    if validation.get("valid") is False:
        return False
    if validation.get("repository_mutation_attempt"):
        return False
    runner = run.get("runner", {})
    return runner.get("raw_findings_count", 0) == 0
