from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .capability_gap import latest_capability_gaps
from .feedback_store import list_findings
from .ledger import append_declared_jsonl, load_jsonl
from .proactive_priority import latest_priorities
from .runs_reader import read_runs_rows
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now

# M12/E8 — a proactive ranking only becomes WORK above this bar. The
# priority scale is 0-100 (impact x opportunity x 100); 60 requires a
# high-impact tool with most opportunity signals firing, so quiet nights
# do not flood the mission store with low-value maintenance candidates.
PROACTIVE_CANDIDATE_MIN_PRIORITY: float = 60.0


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
    for gap in latest_capability_gaps(base_dir=base_dir):
        # No cycle-id equality filter. Gap detection runs in
        # learning_post_evidence_closure, AFTER mission_ingest — so at ingest
        # time the newest batch always carries the PREVIOUS cycle's id and
        # the filter made the coverage-gap -> mission path structurally
        # unreachable in a standard cycle. latest_capability_gaps already
        # returns only the most recent batch; recency is the guard, and
        # adoption idempotency absorbs re-reads.
        candidates.append(_candidate_from_capability_gap(cycle_id, gap))
    # M12/E8 — the proactive ranking's first consumer. compute_proactive_
    # priorities persisted "where to invest next" every cycle and nothing
    # read it: ARIA ranked its investments nightly and never invested.
    # High-priority entries become maintenance candidates; adoption
    # idempotency (mission identity = source_kind|source_id|repo_hash)
    # folds the same tool re-ranked tomorrow into its standing mission.
    priorities = latest_priorities(base_dir=root)
    for entry in (priorities or {}).get("top") or []:
        if not isinstance(entry, dict):
            continue
        if float(entry.get("priority") or 0) < PROACTIVE_CANDIDATE_MIN_PRIORITY:
            continue
        candidates.append(_candidate_from_proactive(cycle_id, entry))
    for run in list(read_runs_rows(runs_path(root), base_dir=root)):
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
    append_declared_jsonl(root / "tasks" / "task-candidates.jsonl", payload, expected_surface="task_candidates")
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
    # Plan 023 v3 §D-3 (M-E) — source_id chain reads event_id first
    # (canonical pressure-event identity emitted by feedback.py
    # derive_pressure), then falls back to pressure_id (legacy schema
    # v1 historical row). Pre-Plan-023 the chain was reversed
    # (pressure_id-first), so v2 pressures with event_id populated
    # got the synthetic "pressure" string as source_id when legacy
    # pressure_id was absent.
    source_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "pressure")
    score = float(pressure.get("score") or 0)
    # Plan 023 v3 §D-3 (M-F) — evidence_refs key-presence check, not
    # truthiness. Empty list `[]` is the canonical "no evidence"
    # signal; the pre-fix `or pressure.get("evidence")` chain treated
    # `[]` as falsy and fell through to legacy `evidence`. Post-fix:
    # if `evidence_refs` is in the pressure dict, use it (even when
    # empty); only fall through to legacy when key is absent.
    if "evidence_refs" in pressure:
        evidence_source = pressure["evidence_refs"]
    else:
        evidence_source = pressure.get("evidence")
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "pressure", source_id),
        "cycle_id": cycle_id,
        "source": "pressure",
        "source_id": source_id,
        "source_authority": "deterministic_pressure",
        "title": str(pressure.get("recommended_action") or pressure.get("reason") or source_id),
        "problem": str(pressure.get("reason") or source_id),
        # Plan 022 C-1b — pressure schema v2 carries `evidence_refs`
        # (path-string list) populated by derive_pressure (Plan 022 C-1).
        # Legacy schema v1 used `evidence` for the same data.
        # Plan 023 v3 (M-F) — key-presence check (above) preserves
        # empty-list semantics.
        "evidence_refs": _strings(evidence_source),
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


def _candidate_from_proactive(cycle_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    tool_id = str(entry.get("tool_id") or "")
    reasons = _strings(entry.get("reasons"))
    # M12/E8 — proactive work is unblocked by definition: the ranking's
    # whole point is work ARIA can start without an operator (build the
    # goldset, gather judgments). Its score is the ranking's own priority
    # (already 0-100), so the reactive sources keep outranking it when
    # something is actually on fire.
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "proactive", tool_id),
        "cycle_id": cycle_id,
        "source": "proactive_priority",
        "source_id": tool_id,
        "source_authority": "proactive_ranking",
        "title": f"Invest in {tool_id}: {', '.join(reasons) or 'high impact x opportunity'}",
        "problem": (
            f"{tool_id} ranks priority {entry.get('priority')} "
            f"(impact {entry.get('impact')}, opportunity {entry.get('opportunity')}); "
            f"signals: {', '.join(reasons) or 'none recorded'}"
        ),
        "evidence_refs": [],
        "candidate_tools": [tool_id],
        "risk_class": "triage_only",
        "validation_commands": ["PYTHONPATH=aria-kernel python3 -m aria_kernel integrity verify"],
        "score": float(entry.get("priority") or 0),
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


def _candidate_from_capability_gap(cycle_id: str, gap: dict[str, Any]) -> dict[str, Any]:
    # Wave 2 PR 1.2 — `gap_id` is CYCLE-SCOPED: `capability_gap._gap` derives it
    # as sha256(f"{cycle_id}:{gap_type}:{source_id}"), so the same gap
    # re-detected tomorrow carries a different one. Using it as the candidate's
    # identity gave every capability gap a fresh mission every night, which is
    # exactly the per-cycle churn persistent missions exist to end.
    #
    # `capability_gap_key` is the content-derived key
    # (`registry:ghost:<tool_id>`, `coverage:<service>`, …) that
    # `detect_capability_gaps` already dedups on — the same identity, one layer
    # up, that simply never reached the candidate. `gap_id` stays as the
    # fallback: a gap without a key is a capability_gap.py defect, and dropping
    # the work would hide it.
    source_id = str(gap.get("capability_gap_key") or gap.get("gap_id"))
    return {
        "schema_version": 1,
        "task_id": _task_id(cycle_id, "capability_gap", source_id),
        "cycle_id": cycle_id,
        "source": "capability_gap",
        "source_id": source_id,
        "source_authority": "capability_gap",
        "title": str(gap.get("title") or gap.get("gap_id")),
        "problem": str(gap.get("title") or gap.get("gap_id")),
        "evidence_refs": _strings(gap.get("evidence_refs")),
        "candidate_tools": [],
        "related_specialized_agent_domains": _strings(gap.get("related_existing_agents")),
        "risk_class": "agent_genesis",
        "validation_commands": _strings(gap.get("candidate_validation_commands")),
        "score": float(gap.get("score") or 0),
        "blocked_by": _strings(gap.get("blocked_by")),
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
