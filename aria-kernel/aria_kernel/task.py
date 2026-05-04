from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .feedback_store import list_findings
from .ledger import append_jsonl, load_jsonl
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def generate_task_candidates(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    pressure_payload = _read_json(root / "pressure" / f"{cycle_id}.json")
    candidates: list[dict[str, Any]] = []
    for pressure in pressure_payload.get("pressures", []) if isinstance(pressure_payload.get("pressures"), list) else []:
        if not isinstance(pressure, dict):
            continue
        candidates.append(_candidate_from_pressure(cycle_id, pressure))
    for finding in list_findings(status="open", base_dir=base_dir):
        candidates.append(_candidate_from_finding(cycle_id, finding))
    for run in load_jsonl(runs_path(root)):
        if run.get("cycle_id") != cycle_id or run.get("status") != "ok":
            continue
        raw_count = int(run.get("runner", {}).get("raw_findings_count") or 0)
        emitted_count = len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0
        if raw_count > 0 and emitted_count == 0:
            candidates.append(_candidate_from_shadow_summary(cycle_id, run, raw_count))
    candidates.sort(key=lambda item: (-float(item["score"]), item["task_id"]))
    candidates = candidates[:limit]
    payload = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "cycle_id": cycle_id,
        "task_count": len(candidates),
        "tasks": candidates,
    }
    append_jsonl(root / "tasks" / "task-candidates.jsonl", payload)
    return payload


def explain_task(
    *,
    task_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "tasks" / "task-candidates.jsonl")
    for row in reversed(rows):
        for task in row.get("tasks", []) if isinstance(row.get("tasks"), list) else []:
            if isinstance(task, dict) and task.get("task_id") == task_id:
                return task
    raise ValueError(f"task not found: {task_id}")


def latest_tasks(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "tasks" / "task-candidates.jsonl")
    if not rows:
        return []
    tasks = rows[-1].get("tasks", [])
    return tasks if isinstance(tasks, list) else []


def _candidate_from_pressure(cycle_id: str, pressure: dict[str, Any]) -> dict[str, Any]:
    source_id = str(pressure.get("pressure_id") or "pressure")
    score = float(pressure.get("score") or 0)
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "pressure", source_id),
        "cycle_id": cycle_id,
        "source": "pressure",
        "source_id": source_id,
        "source_authority": "deterministic_pressure",
        "title": str(pressure.get("recommended_action") or pressure.get("reason") or source_id),
        "problem": str(pressure.get("reason") or source_id),
        "evidence_refs": _strings(pressure.get("evidence")),
        "candidate_tools": _strings(pressure.get("candidate_tools")),
        "risk_class": _risk_from_pressure(pressure),
        "validation_commands": ["PYTHONPATH=aria-kernel python3 -m aria_kernel integrity verify"],
        "score": round(score, 3),
        "blocked_by": _strings(pressure.get("blocked_by")),
    }


def _candidate_from_finding(cycle_id: str, finding: dict[str, Any]) -> dict[str, Any]:
    payload = finding.get("finding", {}) if isinstance(finding.get("finding"), dict) else {}
    severity = str(payload.get("severity") or "medium")
    score = {"critical": 100, "high": 85, "medium": 60, "low": 35}.get(severity, 50)
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "finding", str(finding.get("finding_id"))),
        "cycle_id": cycle_id,
        "source": "finding",
        "source_id": str(finding.get("finding_id")),
        "source_authority": "active_finding",
        "title": str(payload.get("message") or finding.get("finding_id")),
        "problem": str(payload.get("message") or finding.get("finding_id")),
        "evidence_refs": [e.get("path") for e in payload.get("evidence", []) if isinstance(e, dict) and e.get("path")],
        "candidate_tools": [str(finding.get("tool_id"))],
        "risk_class": "requires_impact_plan",
        "validation_commands": ["npm run test", "npm run lint"],
        "score": score,
        "blocked_by": [],
    }


def _candidate_from_shadow_summary(cycle_id: str, run: dict[str, Any], raw_count: int) -> dict[str, Any]:
    tool_id = str(run.get("tool_id"))
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "shadow", tool_id),
        "cycle_id": cycle_id,
        "source": "shadow_run_summary",
        "source_id": tool_id,
        "source_authority": "shadow_draft",
        "title": f"Triage {raw_count} SHADOW findings from {tool_id}",
        "problem": f"{tool_id} produced {raw_count} suppressed SHADOW findings that need calibration before action.",
        "evidence_refs": _strings(run.get("read_paths"))[:20],
        "candidate_tools": [tool_id],
        "risk_class": "triage_only",
        "validation_commands": ["PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'"],
        "score": min(75, 30 + raw_count),
        "blocked_by": ["operator_feedback_required"],
    }


def _risk_from_pressure(pressure: dict[str, Any]) -> str:
    if pressure.get("source") == "migration_surface_repeat":
        return "migration_or_schema"
    if pressure.get("severity") == "high":
        return "requires_impact_plan"
    return "planning_only"


def _task_id(cycle_id: str, source: str, source_id: str) -> str:
    digest = hashlib.sha256(f"{cycle_id}:{source}:{source_id}".encode("utf-8")).hexdigest()[:12]
    return f"task-{digest}"


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _strings(value: Any) -> list[str]:
    return [str(item) for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []
