from __future__ import annotations

from pathlib import Path
from typing import Any

from .fixture_runner import latest_fixture_status
from .readiness import adapter_active_readiness, is_zero_finding_stable_shadow_run
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
        if not operator_approval_ref:
            raise GovernanceError("SHADOW -> ACTIVE requires operator approval ref")
        readiness = adapter_active_readiness(tool_id, base_dir=base_dir)
        if not readiness["active_ready"]:
            blockers = ", ".join(readiness["blocked_by"])
            raise GovernanceError(f"SHADOW -> ACTIVE readiness blocked: {blockers}")
        return transition_tool(
            tool_id,
            target_status,
            reason=reason,
            base_dir=base_dir,
            operator_approval=True,
            precision=1.0 if readiness["zero_finding_lane"] else readiness["precision"],
            critical_false_positives=readiness["critical_false_positives"],
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
    return is_zero_finding_stable_shadow_run(run)
