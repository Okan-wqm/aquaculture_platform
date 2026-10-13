"""The orchestrator's exits and their cycles, written by the production writers (ARIA-MEDIUM-417).

An ``autonomy_orchestrator_exit`` governance row per run and a
``cycle_completed`` transition per cycle, in the shape the live store holds
them. Shared by the doctor's ``orchestrator`` organ tests (``test_doctor``)
and the self-improvement opener's repair-loop tests
(``test_self_improvement_remedy``), so the streak both read is one fixture.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from aria_kernel.autonomy_state import AutonomyStateReducer
from aria_kernel.tool_registry import append_tools_governance


def record_exit(tools: Path, reason: str, cycles_completed: int) -> None:
    append_tools_governance(tools, "autonomy_orchestrator_exit", {
        "auto_merges_completed": 0, "cycles_completed": cycles_completed,
        "daemon_id": "autonomy", "exit_reason": reason,
        "planner_claims_dispatched": 0, "worker_assignments_dispatched": 0,
    })


def record_cycle_completed(tools: Path, cycle_id: str, status: str, summary: dict[str, Any]) -> None:
    AutonomyStateReducer.transition(
        tools, cycle_id=cycle_id, phase="cycle_started", status="ok", profile="standard",
    )
    AutonomyStateReducer.transition(
        tools, cycle_id=cycle_id, phase="cycle_completed", status=status,
        profile="standard", details={"summary": {"schema_version": 2, "cycle_id": cycle_id, **summary}},
    )


def record_failed_night(tools: Path, cycle_id: str, *, failed_phases: list[dict[str, Any]],
                        runtime_status: str = "failed", error: str | None = None) -> None:
    """One run that died ``cycle_failed``: its failed cycle, then its exit (the live order)."""
    summary: dict[str, Any] = {
        "status": "failed", "runtime_status": runtime_status, "failed_phases": failed_phases,
        "non_ok_tools": [], "artifact_integrity": {"status": "ok", "valid": True, "issues": []},
    }
    if error is not None:
        summary["error"] = error
    record_cycle_completed(tools, cycle_id, "failed", summary)
    record_exit(tools, "cycle_failed", 0)


__all__ = ["record_cycle_completed", "record_exit", "record_failed_night"]
