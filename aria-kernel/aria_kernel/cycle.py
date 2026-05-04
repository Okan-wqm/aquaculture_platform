from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from .cycle_diff import run_cycle_diff
from .discovery import run_discovery
from .ledger import append_jsonl
from .memory import update_memory
from .observability import generate_observability_dashboard, record_cycle_metrics
from .pressure import run_pressure
from .reflection import run_reflection
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, utc_now
from .tool_runner import run_tool


RUNNABLE_STATUSES = ("SANDBOX", "SHADOW", "ACTIVE", "CALIBRATE")


def run_cycle(
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
    discovery_only: bool = False,
    shadow_only: bool = False,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    tools_root = ensure_tools_dir(base_dir)
    started = time.monotonic()
    if _stop_requested(tools_root):
        return _record_cycle_event(
            tools_root,
            {
                "schema_version": 1,
                "at": utc_now(),
                "cycle_id": cycle_id,
                "event": "stopped",
                "reason": "ARIA_STOP present before cycle start",
            },
        )

    _record_cycle_event(
        tools_root,
        {
            "schema_version": 1,
            "at": utc_now(),
            "cycle_id": cycle_id,
            "event": "started",
            "workspace_root": root.as_posix(),
            "discovery_only": discovery_only,
            "shadow_only": shadow_only,
        },
    )
    try:
        return _run_cycle_body(
            root=root,
            tools_root=tools_root,
            cycle_id=cycle_id,
            base_dir=base_dir,
            discovery_only=discovery_only,
            shadow_only=shadow_only,
            started=started,
        )
    except Exception as exc:
        _record_cycle_event(
            tools_root,
            {
                "schema_version": 1,
                "at": utc_now(),
                "cycle_id": cycle_id,
                "event": "failed",
                "reason": str(exc),
            },
        )
        _record_cycle_observability(tools_root, cycle_id, started, status="failed", artifact_count=0)
        raise


def _run_cycle_body(
    *,
    root: Path,
    tools_root: Path,
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None,
    discovery_only: bool,
    shadow_only: bool,
    started: float,
) -> dict[str, Any]:
    discovery = run_discovery(workspace_root=root, cycle_id=cycle_id, base_dir=base_dir)
    diff = run_cycle_diff(cycle_id=cycle_id, base_dir=base_dir)
    if discovery_only:
        return _finish(
            tools_root,
            cycle_id,
            {
                "discovery": _compact_discovery(discovery),
                "cycle_diff": _compact_diff(diff),
                "tool_decisions": [],
            },
            started,
        )

    if _stop_requested(tools_root):
        return _stopped_after_checkpoint(tools_root, cycle_id, "discovery")

    memory = update_memory(cycle_id=cycle_id, base_dir=base_dir, include_tool_candidates=False)
    pressure = run_pressure(cycle_id=cycle_id, base_dir=base_dir)
    tool_decisions = []
    for tool in _cycle_tools(base_dir=base_dir, shadow_only=shadow_only):
        if _stop_requested(tools_root):
            return _stopped_after_checkpoint(tools_root, cycle_id, f"before tool {tool['tool_id']}")
        default_input = tool.get("default_input", {})
        if not isinstance(default_input, dict):
            default_input = {}
        input_payload = {
            **default_input,
            "cycle_id": cycle_id,
            "workspace_root": root.as_posix(),
            "pressure_summary": pressure.get("summary", {}),
        }
        try:
            decision = run_tool(
                tool["tool_id"],
                input_payload,
                cycle_id,
                workspace_root=root,
                base_dir=base_dir,
            )
            tool_decisions.append(decision)
        except GovernanceError as exc:
            tool_decisions.append(
                _record_cycle_event(
                    tools_root,
                    {
                        "schema_version": 1,
                        "at": utc_now(),
                        "cycle_id": cycle_id,
                        "event": "tool_error",
                        "tool_id": tool["tool_id"],
                        "reason": str(exc),
                    },
                ),
            )
    candidate_memory = update_memory(
        cycle_id=cycle_id,
        base_dir=base_dir,
        include_discovery_beliefs=False,
        include_tool_candidates=True,
    )
    pressure = run_pressure(cycle_id=cycle_id, base_dir=base_dir)
    reflection = run_reflection(cycle_id=cycle_id, base_dir=base_dir)
    return _finish(
        tools_root,
        cycle_id,
        {
            "discovery": _compact_discovery(discovery),
            "cycle_diff": _compact_diff(diff),
            "memory": memory,
            "candidate_memory": candidate_memory,
            "pressure": pressure,
            "reflection": reflection,
            "tool_decisions": tool_decisions,
        },
        started,
    )


def _cycle_tools(*, base_dir: str | os.PathLike[str] | None, shadow_only: bool) -> list[dict[str, Any]]:
    candidates = [
        tool
        for tool in list_tools(base_dir=base_dir)
        if tool.get("status") in RUNNABLE_STATUSES and tool.get("runner")
    ]
    if shadow_only:
        candidates = [tool for tool in candidates if tool.get("status") in ("SHADOW", "CALIBRATE")]
    return sorted(candidates, key=lambda tool: str(tool.get("tool_id")))


def _finish(tools_root: Path, cycle_id: str, payload: dict[str, Any], started: float) -> dict[str, Any]:
    row = _record_cycle_event(
        tools_root,
        {
            "schema_version": 1,
            "at": utc_now(),
            "cycle_id": cycle_id,
            "event": "completed",
            "tool_decision_count": len(payload.get("tool_decisions", [])),
        },
    )
    metrics = _record_cycle_observability(
        tools_root,
        cycle_id,
        started,
        status="ok",
        artifact_count=_artifact_count(payload),
    )
    dashboard = generate_observability_dashboard(cycle_id=cycle_id, base_dir=tools_root)
    return {"schema_version": 1, "cycle_id": cycle_id, "status": "completed", "event": row, "cycle_metrics": metrics, "observability_dashboard": dashboard, **payload}


def _stopped_after_checkpoint(tools_root: Path, cycle_id: str, checkpoint: str) -> dict[str, Any]:
    row = _record_cycle_event(
        tools_root,
        {
            "schema_version": 1,
            "at": utc_now(),
            "cycle_id": cycle_id,
            "event": "stopped",
            "reason": f"ARIA_STOP present after {checkpoint}",
        },
    )
    return {"schema_version": 1, "cycle_id": cycle_id, "status": "stopped", "event": row}


def _record_cycle_observability(
    tools_root: Path,
    cycle_id: str,
    started: float,
    *,
    status: str,
    artifact_count: int,
) -> dict[str, Any]:
    duration_ms = int(round((time.monotonic() - started) * 1000))
    return record_cycle_metrics(
        cycle_id=cycle_id,
        phase_durations_ms={"cycle_total": duration_ms},
        artifact_count=artifact_count,
        status=status,
        base_dir=tools_root,
    )


def _artifact_count(payload: dict[str, Any]) -> int:
    count = 0
    for value in payload.values():
        if isinstance(value, list):
            count += len(value)
        elif isinstance(value, dict):
            count += 1
        elif value is not None:
            count += 1
    return count


def _record_cycle_event(tools_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    return append_jsonl(tools_root / "cycles.jsonl", payload)


def _stop_requested(tools_root: Path) -> bool:
    return (tools_root / "ARIA_STOP").exists()


def _compact_discovery(discovery: dict[str, Any]) -> dict[str, Any]:
    fingerprint = discovery.get("fingerprint", {})
    completion = discovery.get("completion_proof", {})
    return {
        "artifact_dir": discovery.get("artifact_dir"),
        "completion_proof": completion,
        "fingerprint": {
            "tracked_file_count": fingerprint.get("tracked_file_count"),
            "service_count": fingerprint.get("service_count"),
            "web_module_count": fingerprint.get("web_module_count"),
            "platform_lib_count": fingerprint.get("platform_lib_count"),
            "shared_lib_count": fingerprint.get("shared_lib_count"),
            "adr_count": fingerprint.get("adr_count"),
            "migration_count": fingerprint.get("migration_count"),
            "has_nx": fingerprint.get("has_nx"),
            "has_package_json": fingerprint.get("has_package_json"),
        },
    }


def _compact_diff(diff: dict[str, Any]) -> dict[str, Any]:
    return {
        "baseline": diff.get("baseline"),
        "previous_cycle_id": diff.get("previous_cycle_id"),
        "summary": diff.get("summary", {}),
        "fingerprint_delta": diff.get("fingerprint_delta", {}),
    }
