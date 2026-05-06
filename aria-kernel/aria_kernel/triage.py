from __future__ import annotations

import fnmatch
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .fitness import latest_agent_fitness
from .agent_network import latest_agent_network_hash
from .ledger import append_jsonl, load_jsonl
from .pressure import effective_workspace_pressures
from .tool_registry import append_tools_governance, update_tools_index
from .workspace import WorkspacePaths


TIERS = {"auto_fix_safe", "needs_review", "human_only", "observe", "blocked"}
FITNESS_STALENESS_DAYS = 7


def triage_policy_apply(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
) -> dict[str, Any]:
    if tools_root is None:
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "tools_root_required", "triaged_count": 0}
    root = Path(tools_root)
    existing = {_decision_key(row) for row in load_jsonl(root / "triage" / "decisions.jsonl")}
    fitness = {row.get("agent_name"): row for row in latest_agent_fitness(base_dir=root)}
    index_hash = latest_agent_network_hash(base_dir=root)
    decisions: list[dict[str, Any]] = []
    for pressure in effective_workspace_pressures(paths):
        pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
        if not pressure_id or pressure.get("effective_state") not in {"active", "faded", "sleeping"}:
            continue
        tier, reasons = classify_pressure(pressure)
        target_agent = resolve_target_agent(pressure, root)
        if target_agent and fitness.get(target_agent, {}).get("tier") == "QUARANTINED":
            tier = "blocked"
            reasons.append("agent_quarantined")
            append_tools_governance(root, "agent_dispatch_quarantined", {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "target_agent": target_agent})
        elif target_agent and fitness.get(target_agent, {}).get("tier") == "CALIBRATE" and tier == "auto_fix_safe":
            tier = "needs_review"
            reasons.append("agent_calibrating")
        elif target_agent and _is_fitness_stale(fitness.get(target_agent, {})) and tier == "auto_fix_safe":
            tier = "needs_review"
            reasons.append("agent_fitness_stale")
            append_tools_governance(root, "agent_fitness_stale_downgrade", {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "target_agent": target_agent})
        row = {
            "$schema": "aria/triage-decision/v1",
            "schema_version": 1,
            "cycle_id": cycle_id,
            "pressure_event_id": pressure_id,
            "triage_tier": tier,
            "target_agent": target_agent,
            "reasons": reasons,
            "required_tests": derive_required_tests(paths.repo_root, _evidence_paths(pressure)),
            "index_hash_at_decision": index_hash,
        }
        if _decision_key(row) in existing:
            continue
        stored = append_jsonl(root / "triage" / "decisions.jsonl", row)
        update_tools_index(root)
        append_tools_governance(root, "pressure_triaged", {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "tier": tier, "target_agent": target_agent})
        decisions.append(stored)
    return {"schema_version": 1, "cycle_id": cycle_id, "triaged_count": len(decisions), "decisions": decisions}


def classify_pressure(pressure: dict[str, Any]) -> tuple[str, list[str]]:
    if pressure.get("ref_stale") == "stale" and not pressure.get("trusted_effective"):
        return "observe", ["stale_only_evidence"]
    paths = _evidence_paths(pressure)
    if not paths:
        return "blocked", ["unresolved_evidence_paths"]
    if any(_matches(path, ["infra/**", ".github/**", "docker/**", "**/migrations/**", "**/*secret*", "**/*credential*", "apps/billing-service/**"]) for path in paths):
        return "human_only", ["unsafe_or_governed_path"]
    if any(path.startswith(("apps/", "web/", "libs/", "platform/libs/")) and "/src/" in path for path in paths):
        return "needs_review", ["runtime_path"]
    if all(_matches(path, ["docs/**", "*.md", "aria-kernel/tests/**", "tests/**", "e2e/**", "tools/aria-poc/**", "scripts/**", "tools/**"]) for path in paths):
        return "auto_fix_safe", ["low_risk_path"]
    return "blocked", ["unresolved_policy"]


def resolve_target_agent(pressure: dict[str, Any], tools_root: Path) -> str | None:
    routing = _routing_table(tools_root)
    gap = str(pressure.get("capability_gap_key") or "")
    surface = gap.split(":", 1)[0] if gap else ""
    for key in (gap, surface, str(pressure.get("primitive") or "").lower()):
        if key in routing:
            return routing[key]
    drives = pressure.get("drives") if isinstance(pressure.get("drives"), list) else []
    if "skill_birth" in drives:
        return routing.get("skill_birth")
    return None


def derive_required_tests(repo_root: Path, evidence_paths: list[str]) -> list[str]:
    commands: list[str] = []
    for path in evidence_paths:
        clean = path.split(":", 1)[0].removeprefix("./")
        if clean.startswith("aria-kernel/"):
            commands.append("python -m unittest discover aria-kernel -p '*test*.py'")
        elif clean.startswith("tools/aria-poc/"):
            commands.append(f"python -m pytest {clean}")
        else:
            project = _nearest_nx_project(repo_root, clean)
            if project:
                commands.append(f"npx nx test {project}")
    return sorted(dict.fromkeys(commands))


def _nearest_nx_project(repo_root: Path, rel_path: str) -> str | None:
    current = repo_root / rel_path
    if current.is_file():
        current = current.parent
    for parent in [current, *current.parents]:
        if parent == repo_root.parent:
            break
        project_json = parent / "project.json"
        if project_json.exists():
            try:
                import json

                payload = json.loads(project_json.read_text(encoding="utf-8"))
                return str(payload.get("name") or parent.name)
            except (OSError, ValueError):
                return parent.name
        if parent == repo_root:
            break
    return None


def _routing_table(root: Path) -> dict[str, str]:
    path = root / "triage" / "agent-routing.json"
    if not path.exists():
        return {}
    try:
        import json

        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    table = payload.get("routes") if isinstance(payload, dict) else payload
    if not isinstance(table, dict):
        return {}
    return {str(key): str(value) for key, value in table.items() if str(key).strip() and str(value).strip()}


def _evidence_paths(pressure: dict[str, Any]) -> list[str]:
    refs = pressure.get("evidence_refs") if isinstance(pressure.get("evidence_refs"), list) else []
    return [str(ref) for ref in refs if isinstance(ref, str) and not str(ref).startswith(("agent:", "manual:", "github:", "git:"))]


def _matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def list_triage_decisions(
    tools_root: str | Path,
    *,
    tier: str | None = None,
    target_agent: str | None = None,
    cycle_id: str | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(Path(tools_root) / "triage" / "decisions.jsonl")
    if tier is not None:
        rows = [r for r in rows if r.get("triage_tier") == tier]
    if target_agent is not None:
        rows = [r for r in rows if r.get("target_agent") == target_agent]
    if cycle_id is not None:
        rows = [r for r in rows if r.get("cycle_id") == cycle_id]
    return rows


def explain_triage(
    tools_root: str | Path,
    triage_id: str,
) -> dict[str, Any]:
    rows = load_jsonl(Path(tools_root) / "triage" / "decisions.jsonl")
    matches = [
        row for row in rows
        if row.get("pressure_event_id") == triage_id
        or row.get("event_id") == triage_id
        or _decision_key(row) == triage_id
    ]
    if not matches:
        return {
            "schema_version": 1,
            "status": "not_found",
            "triage_id": triage_id,
            "decisions": [],
        }
    return {
        "schema_version": 1,
        "status": "found",
        "triage_id": triage_id,
        "latest": matches[-1],
        "history": matches,
    }


def _decision_key(row: dict[str, Any]) -> str:
    return f"{row.get('pressure_event_id')}:{row.get('triage_tier')}:{row.get('target_agent')}"


def _is_fitness_stale(row: dict[str, Any], threshold_days: int = FITNESS_STALENESS_DAYS) -> bool:
    """Return True when the fitness row is older than threshold_days.

    Defensive default: missing or unparseable recorded_at counts as stale so a
    silent absence cannot promote auto_fix_safe.
    """
    if not row:
        return False  # no agent fitness record → caller short-circuits earlier
    recorded = row.get("recorded_at")
    if not isinstance(recorded, str) or not recorded.strip():
        return True
    try:
        parsed = datetime.fromisoformat(recorded.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)) > timedelta(days=threshold_days)
