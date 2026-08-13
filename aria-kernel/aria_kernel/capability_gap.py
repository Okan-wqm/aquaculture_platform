from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .agent_priors import related_agents_for_paths
from .agent_network import latest_agent_network_hash
from .agent_routing import ROUTING_TABLE_REL, unowned_projects
from .fitness import list_fitness_reports
from .ledger import append_declared_jsonl, load_jsonl
from .runs_reader import read_runs_rows
from .memory import list_memory
from .pressure import effective_workspace_pressures
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


# Plan 026R §E.9 — closed-enum of capability_gap types emitted by
# this module. The learning router (`learning._skill_or_agent_genesis`)
# branches on these values; the AST invariant at
# tests/test_capability_gap_router_parity.py enforces that the
# union of types emitted by capability_gap.py equals the union of
# gap_type branches handled by learning.py. Adding a new gap_type
# requires updating BOTH sides + the router test.
#
# * agent_gap — capability needs a NEW specialist agent (default)
# * existing_agent_extension — capability fits an existing agent
# * skill_gap — capability fits a NEW skill under an existing agent
#   (narrow single-purpose pattern, routes to skill_genesis NOT
#   agent_genesis). Emitted when the source pressure carries a
#   `skill_candidate=True` marker (operator-visible signal that
#   the gap fits a skill-shaped intervention).
# * policy_gap — dependency-policy gap (dependency_currency dim)
# * adapter_gap — fitness/adapter gap (default low-fitness signal)
CAPABILITY_GAP_TYPES: frozenset[str] = frozenset({
    "agent_gap",
    "existing_agent_extension",
    "skill_gap",
    "policy_gap",
    "adapter_gap",
})


def detect_capability_gaps(
    *,
    cycle_id: str,
    paths: Any | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    index_hash = latest_agent_network_hash(base_dir=root)
    gaps = []
    if paths is not None:
        gaps.extend(_gaps_from_unowned_pressures(cycle_id, paths, root, index_hash))
        gaps.extend(_gaps_from_coverage_gaps(cycle_id, paths, root, index_hash, base_dir))
    gaps.extend(_gaps_from_adapter_registry(cycle_id, paths, root, index_hash))
    gaps.extend(_gaps_from_shadow_runs(cycle_id, root, base_dir))
    gaps.extend(_gaps_from_unknowns(cycle_id, base_dir))
    gaps.extend(_gaps_from_fitness(cycle_id, base_dir))
    unique: dict[str, dict[str, Any]] = {}
    for gap in gaps:
        key = str(gap.get("capability_gap_key") or gap["gap_id"])
        existing = unique.get(key)
        if existing is None or _source_rank(str(gap.get("primary_source"))) < _source_rank(str(existing.get("primary_source"))):
            unique[key] = gap
        elif existing is not None:
            existing["source_types"] = sorted(set(existing.get("source_types", []) + gap.get("source_types", [])))
    ordered = sorted(unique.values(), key=lambda item: (-item["score"], item["gap_id"]))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "gap_count": len(ordered),
        "gaps": ordered,
    }
    return append_declared_jsonl(root / "capability-gaps" / "gaps.jsonl", row, expected_surface="capability_gaps")


def list_capability_gaps(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "capability-gaps" / "gaps.jsonl")


def latest_capability_gaps(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    rows = list_capability_gaps(base_dir=base_dir)
    if not rows:
        return []
    gaps = rows[-1].get("gaps", [])
    return gaps if isinstance(gaps, list) else []


def _gaps_from_adapter_registry(
    cycle_id: str,
    paths: Any | None,
    root: Path,
    index_hash: str | None,
) -> list[dict[str, Any]]:
    registry_path = root / "registry.json"
    if not registry_path.exists():
        return []
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [
            _gap(
                cycle_id=cycle_id,
                gap_type="adapter_gap",
                source_id="registry-unreadable",
                title="ARIA registry is unreadable",
                evidence_refs=[registry_path.as_posix()],
                related_agents=[],
                score=85,
                blocked_by=["registry_repair_required"],
                capability_gap_key="registry:unreadable",
                primary_source="registry",
                source_types=["registry"],
                index_hash_at_decision=index_hash,
            ),
        ]
    tools = [tool for tool in registry.get("tools", []) if isinstance(tool, dict)]
    registry_ids = {str(tool.get("tool_id")) for tool in tools if tool.get("tool_id")}
    manifests = {}
    if paths is not None:
        repo_root = Path(getattr(paths, "repo_root")).resolve()
        manifest_dir = repo_root / "tools" / "aria-adapters"
        if manifest_dir.exists():
            for manifest in manifest_dir.glob("*.tool.json"):
                try:
                    payload = json.loads(manifest.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                tool_id = str(payload.get("tool_id") or "")
                if tool_id:
                    manifests[tool_id] = manifest
    manifest_ids = set(manifests)
    gaps: list[dict[str, Any]] = []
    for tool in tools:
        tool_id = str(tool.get("tool_id") or "")
        argv = ((tool.get("runner") or {}).get("argv") or [])
        if any(isinstance(part, str) and any(token in part for token in ("shadow_runner.py", "noop.py", "echo")) for part in argv):
            gaps.append(
                _gap(
                    cycle_id=cycle_id,
                    gap_type="adapter_gap",
                    source_id=f"stub:{tool_id}",
                    title=f"Registry tool uses a stub runner: {tool_id}",
                    evidence_refs=[registry_path.as_posix()],
                    related_agents=[],
                    score=95,
                    blocked_by=["real_adapter_required"],
                    capability_gap_key=f"registry:stub_runner:{tool_id}",
                    primary_source="registry",
                    source_types=["registry"],
                    index_hash_at_decision=index_hash,
                ),
            )
        if tool_id and tool_id not in manifest_ids:
            gaps.append(
                _gap(
                    cycle_id=cycle_id,
                    gap_type="adapter_gap",
                    source_id=f"ghost:{tool_id}",
                    title=f"Registry tool has no manifest: {tool_id}",
                    evidence_refs=[registry_path.as_posix()],
                    related_agents=[],
                    score=85,
                    blocked_by=["manifest_required"],
                    capability_gap_key=f"registry:ghost:{tool_id}",
                    primary_source="registry",
                    source_types=["registry"],
                    index_hash_at_decision=index_hash,
                ),
            )
    for tool_id in sorted(manifest_ids - registry_ids):
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type="adapter_gap",
                source_id=f"orphan:{tool_id}",
                title=f"Adapter manifest is absent from registry: {tool_id}",
                evidence_refs=[manifests[tool_id].as_posix()],
                related_agents=[],
                score=70,
                blocked_by=["registry_compile_required"],
                capability_gap_key=f"registry:orphan:{tool_id}",
                primary_source="registry",
                source_types=["registry"],
                index_hash_at_decision=index_hash,
            ),
        )
    for pressure in _pressure_rows(root):
        pressure_id = str(pressure.get("pressure_id") or pressure.get("event_id") or "unknown")
        for candidate in pressure.get("candidate_tools", []) or []:
            if isinstance(candidate, str) and candidate and candidate not in registry_ids:
                gaps.append(
                    _gap(
                        cycle_id=cycle_id,
                        gap_type="adapter_gap",
                        source_id=f"candidate:{pressure_id}:{candidate}",
                        title=f"Pressure references unreachable tool: {candidate}",
                        evidence_refs=[root.as_posix()],
                        related_agents=[],
                        score=75,
                        blocked_by=["pressure_candidate_repair_required"],
                        capability_gap_key=f"registry:unreachable_candidate:{candidate}",
                        primary_source="registry",
                        source_types=["registry"],
                        index_hash_at_decision=index_hash,
                    ),
                )
    return gaps


def _pressure_rows(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pressure_dir = root / "pressure"
    if not pressure_dir.exists():
        return rows
    for path in pressure_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for pressure in payload.get("pressures", []) if isinstance(payload, dict) else []:
            if isinstance(pressure, dict):
                rows.append(pressure)
    return rows


def _gaps_from_unowned_pressures(cycle_id: str, paths: Any, root: Path, index_hash: str | None) -> list[dict[str, Any]]:
    gaps = []
    for pressure in effective_workspace_pressures(paths):
        pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
        if not pressure_id or pressure.get("effective_state") not in {"active", "faded", "sleeping", None}:
            continue
        if pressure.get("target_agent"):
            continue
        refs = [str(ref) for ref in pressure.get("evidence_refs", []) if isinstance(ref, str)]
        related = related_agents_for_paths(paths=refs, base_dir=root)
        gap_key = str(pressure.get("capability_gap_key") or f"pressure:{pressure_id}")
        # Plan 026R §E.9 — `skill_candidate` pressure marker routes
        # the gap to skill_gap (skill-shaped intervention) rather
        # than agent_gap (new specialist). The existing_agent_extension
        # branch wins precedence when a related agent is present;
        # without a related agent, a skill_candidate signal yields
        # skill_gap and downstream learning.py routes to
        # request_skill_genesis instead of request_agent_genesis.
        if related:
            gap_type = "existing_agent_extension"
        elif pressure.get("skill_candidate") is True:
            gap_type = "skill_gap"
        else:
            gap_type = "agent_gap"
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type=gap_type,
                source_id=pressure_id,
                title=f"Unowned pressure needs agent routing: {gap_key}",
                evidence_refs=refs[:20],
                related_agents=related,
                score=80,
                blocked_by=[],
                capability_gap_key=gap_key,
                primary_source="pressure",
                source_types=["pressure"],
                index_hash_at_decision=index_hash,
            ),
        )
    return gaps


def _gaps_from_coverage_gaps(
    cycle_id: str, paths: Any, root: Path, index_hash: str | None, base_dir: str | Path | None
) -> list[dict[str, Any]]:
    """A service ARIA examined this cycle that NO domain agent owns (empty
    routing-table primary) AND that has an active pressure → an agent-genesis
    candidate. The routing-derived ``unowned`` signal is stronger than an
    unowned pressure: it is a structural "this service has no owner at all".
    Requiring active pressure keeps it high-signal (an inert unowned lib does
    not file a request). Routes to ``existing_agent_extension`` when a related
    agent exists (prefer extension), else ``agent_gap``; the genesis policy +
    human approval gate everything downstream."""
    try:
        unowned = unowned_projects(workspace_root=paths.repo_root, base_dir=base_dir)
    except Exception:
        return []
    if not unowned:
        return []
    # Which unowned services carry activity this cycle (a pressure's evidence
    # lands inside them)? Longest root first so a nested project wins.
    roots = sorted(unowned.items(), key=lambda kv: len(kv[1]), reverse=True)
    active: dict[str, list[str]] = {}
    for pressure in effective_workspace_pressures(paths):
        if pressure.get("effective_state") not in {"active", "faded", "sleeping", None}:
            continue
        refs = [str(ref) for ref in pressure.get("evidence_refs", []) if isinstance(ref, str)]
        for ref in refs:
            normalized = ref.strip()
            if normalized.startswith("./"):
                normalized = normalized[2:]
            normalized = normalized.lstrip("/")
            for name, proot in roots:
                if normalized == proot or normalized.startswith(proot + "/"):
                    active.setdefault(name, []).extend(refs)
                    break
    gaps = []
    for service in sorted(active):
        proot = unowned[service]
        related = related_agents_for_paths(paths=[proot], base_dir=root)
        evidence = [ROUTING_TABLE_REL, proot] + active[service]
        gaps.append(
            _gap(
                cycle_id=cycle_id,
                gap_type="existing_agent_extension" if related else "agent_gap",
                source_id=f"coverage:{service}",
                title=f"Service has active pressure but no owning review agent: {service}",
                evidence_refs=evidence[:20],
                related_agents=related,
                score=75,
                blocked_by=[],
                capability_gap_key=f"coverage:{service}",
                primary_source="coverage",
                source_types=["coverage"],
                index_hash_at_decision=index_hash,
            ),
        )
    return gaps


def _gaps_from_shadow_runs(cycle_id: str, root: Path, base_dir: str | Path | None) -> list[dict[str, Any]]:
    gaps = []
    for run in list(read_runs_rows(runs_path(root), base_dir=root)):
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
                capability_gap_key=f"shadow_run:{run.get('tool_id')}",
                primary_source="shadow-run",
                source_types=["shadow-run"],
                index_hash_at_decision=latest_agent_network_hash(base_dir=base_dir),
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
                capability_gap_key=f"unknown:{reason}",
                primary_source="unknown",
                source_types=["unknown"],
                index_hash_at_decision=latest_agent_network_hash(base_dir=base_dir),
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
                capability_gap_key=f"fitness:{dimension}",
                primary_source="low-fitness",
                source_types=["low-fitness"],
                index_hash_at_decision=latest_agent_network_hash(base_dir=base_dir),
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
    capability_gap_key: str,
    primary_source: str,
    source_types: list[str],
    index_hash_at_decision: str | None,
) -> dict[str, Any]:
    digest = hashlib.sha256(f"{cycle_id}:{gap_type}:{source_id}".encode("utf-8")).hexdigest()[:12]
    return {
        "schema_version": 1,
        "gap_id": f"gap-{digest}",
        "cycle_id": cycle_id,
        "gap_type": gap_type,
        "source_id": source_id,
        "capability_gap_key": capability_gap_key,
        "primary_source": primary_source,
        "source_types": source_types,
        "title": title,
        "evidence_refs": evidence_refs,
        "related_existing_agents": related_agents,
        "recommended_action": "extend_existing_agent" if related_agents else "draft_new_aria_agent",
        "candidate_validation_commands": ["PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'"],
        "score": score,
        "blocked_by": blocked_by,
        "index_hash_at_decision": index_hash_at_decision,
    }


def _source_rank(source: str) -> int:
    order = {"registry": 0, "coverage": 1, "pressure": 2, "shadow-run": 3, "unknown": 4, "low-fitness": 5}
    return order.get(source, 99)
