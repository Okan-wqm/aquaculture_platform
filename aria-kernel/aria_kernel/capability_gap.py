from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .agent_priors import related_agents_for_paths
from .fitness import list_fitness_reports
from .ledger import append_jsonl, load_jsonl
from .memory import list_memory
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def detect_capability_gaps(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    gaps = []
    gaps.extend(_gaps_from_shadow_runs(cycle_id, root, base_dir))
    gaps.extend(_gaps_from_unknowns(cycle_id, base_dir))
    gaps.extend(_gaps_from_fitness(cycle_id, base_dir))
    unique = {gap["gap_id"]: gap for gap in gaps}
    ordered = sorted(unique.values(), key=lambda item: (-item["score"], item["gap_id"]))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "gap_count": len(ordered),
        "gaps": ordered,
    }
    return append_jsonl(root / "capability-gaps" / "gaps.jsonl", row)


def list_capability_gaps(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "capability-gaps" / "gaps.jsonl")


def latest_capability_gaps(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    rows = list_capability_gaps(base_dir=base_dir)
    if not rows:
        return []
    gaps = rows[-1].get("gaps", [])
    return gaps if isinstance(gaps, list) else []


def _gaps_from_shadow_runs(cycle_id: str, root: Path, base_dir: str | Path | None) -> list[dict[str, Any]]:
    gaps = []
    for run in load_jsonl(runs_path(root)):
        if run.get("cycle_id") != cycle_id or run.get("status") != "ok":
            continue
        raw_count = int(run.get("runner", {}).get("raw_findings_count") or 0)
        emitted = run.get("emitted_findings", [])
        if raw_count < 3 or emitted:
            continue
        paths = [str(path) for path in run.get("read_paths", [])[:20]]
        related = related_agents_for_paths(paths=paths, base_dir=base_dir)
        gap_type = "existing_agent_extension" if related else "agent_gap"
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type=gap_type,
                source_id=str(run.get("tool_id")),
                title=f"Triage recurring SHADOW output from {run.get('tool_id')}",
                evidence_refs=paths,
                related_agents=related,
                score=min(90, 45 + raw_count),
                blocked_by=["operator_feedback_required"],
            ),
        )
    return gaps


def _gaps_from_unknowns(cycle_id: str, base_dir: str | Path | None) -> list[dict[str, Any]]:
    rows = list_memory(kind="uncertainties", base_dir=base_dir)
    by_reason: dict[str, list[str]] = {}
    for row in rows:
        reason = str(row.get("reason") or row.get("claim") or "unknown")
        refs = [str(ref) for ref in row.get("evidence_refs", []) if isinstance(ref, str)]
        by_reason.setdefault(reason, []).extend(refs)
    gaps = []
    for reason, refs in by_reason.items():
        unique_refs = sorted(set(refs))
        if len(unique_refs) < 3:
            continue
        related = related_agents_for_paths(paths=unique_refs, base_dir=base_dir)
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type="existing_agent_extension" if related else "agent_gap",
                source_id=reason,
                title=f"Repeated unknown needs capability coverage: {reason}",
                evidence_refs=unique_refs[:20],
                related_agents=related,
                score=70,
                blocked_by=[],
            ),
        )
    return gaps


def _gaps_from_fitness(cycle_id: str, base_dir: str | Path | None) -> list[dict[str, Any]]:
    reports = list_fitness_reports(base_dir=base_dir)
    if not reports:
        return []
    latest = reports[-1]
    gaps = []
    dimensions = latest.get("dimensions", {})
    for dimension, score in dimensions.items() if isinstance(dimensions, dict) else []:
        try:
            numeric = float(score)
        except (TypeError, ValueError):
            continue
        if numeric > 0.25:
            continue
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type="policy_gap" if dimension == "dependency_currency" else "adapter_gap",
                source_id=str(dimension),
                title=f"Low ARIA fitness dimension: {dimension}",
                evidence_refs=[str(latest.get("ledger_hash", "fitness-report"))],
                related_agents=[],
                score=60,
                blocked_by=["fitness_evidence_review_required"],
            ),
        )
    return gaps


def _gap(
    *,
    cycle_id: str,
    gap_type: str,
    source_id: str,
    title: str,
    evidence_refs: list[str],
    related_agents: list[str],
    score: int,
    blocked_by: list[str],
) -> dict[str, Any]:
    digest = hashlib.sha256(f"{cycle_id}:{gap_type}:{source_id}".encode("utf-8")).hexdigest()[:12]
    return {
        "schema_version": 1,
        "gap_id": f"gap-{digest}",
        "cycle_id": cycle_id,
        "gap_type": gap_type,
        "source_id": source_id,
        "title": title,
        "evidence_refs": evidence_refs,
        "related_existing_agents": related_agents,
        "recommended_action": "extend_existing_agent" if related_agents else "draft_new_aria_agent",
        "candidate_validation_commands": ["PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'"],
        "score": score,
        "blocked_by": blocked_by,
    }
