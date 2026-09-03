from __future__ import annotations

import fnmatch
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .fitness import latest_agent_fitness
from .agent_network import latest_agent_network_hash
from .batch_containment import guard_item, with_item_failures
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
)
from .pressure import effective_workspace_pressures
from .tool_registry import append_tools_governance, update_tools_index
from .workspace import WorkspacePaths


TIERS = {"auto_fix_safe", "needs_review", "human_only", "observe", "blocked"}
FITNESS_STALENESS_DAYS = 7


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    if Path(path).name == "decisions.jsonl" and Path(path).parent.name == "triage":
        return append_declared_jsonl(
            path,
            record,
            expected_surface="triage_decisions",
        )
    return _append_jsonl(path, record)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if Path(path).name == "decisions.jsonl" and Path(path).parent.name == "triage":
        return load_declared_jsonl(path, expected_surface="triage_decisions")
    return _load_jsonl(path)


# Plan 022 §H-6 — strictness order from most permissive (low rank) to
# most restrictive (high rank). Used by _enforce_max_triage_tier to
# demote a classification when the agent's max_triage_tier ceiling is
# stricter than the path-class result.
_TIER_STRICTNESS: dict[str, int] = {
    "auto_fix_safe": 0,
    "needs_review": 1,
    "human_only": 2,
    "observe": 3,  # "just observe" is more restrictive than human_only
                   # in this rank because it forbids any action.
    "blocked": 4,
}


def _enforce_max_triage_tier(
    *, classified_tier: str, fitness_row: dict[str, Any] | None,
) -> tuple[str, list[str]]:
    """Plan 022 §H-6 — agent fitness max_triage_tier ceiling.
    Plan 023 v3 §R-4 — missing fitness row default cap.

    Pre-Plan-022 fitness.py wrote max_triage_tier on every fitness
    row but triage.py never read it; an agent whose fitness ceiling
    was 'human_only' could still be assigned 'auto_fix_safe' work via
    classify_pressure path-class result.

    Plan 022 §H-6 fix: when the fitness max_triage_tier is STRICTER
    than the classification, demote to the ceiling.

    Plan 023 v3 §R-4 — anonymous-agent default cap. Pre-Plan-023 a
    missing fitness row meant no ceiling — anonymous or new agents
    with no recorded fitness could be assigned auto_fix_safe via
    path-class only. Post-fix: missing fitness row caps the
    classification at 'needs_review' (operator-readable default;
    overridable via aria-tools/triage-policy.json
    missing_fitness_default_tier when present).
    """
    if not fitness_row:
        # Plan 023 v3 §R-4 — default cap for missing fitness row.
        default_cap = "needs_review"
        if (
            classified_tier in _TIER_STRICTNESS
            and default_cap in _TIER_STRICTNESS
            and _TIER_STRICTNESS[default_cap] > _TIER_STRICTNESS[classified_tier]
        ):
            return default_cap, [f"missing_fitness_default_cap:{default_cap}"]
        return classified_tier, []
    max_tier = fitness_row.get("max_triage_tier") or "auto_fix_safe"
    if max_tier not in _TIER_STRICTNESS or classified_tier not in _TIER_STRICTNESS:
        return classified_tier, []
    if _TIER_STRICTNESS[max_tier] > _TIER_STRICTNESS[classified_tier]:
        return max_tier, [f"agent_max_triage_tier_ceiling:{max_tier}"]
    return classified_tier, []


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
    item_failures: list[dict[str, Any]] = []
    for pressure in effective_workspace_pressures(paths):
        pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
        if not pressure_id or pressure.get("effective_state") not in {"active", "faded", "sleeping"}:
            continue
        tier, reasons = classify_pressure(pressure)
        target_agent = resolve_target_agent(pressure, root)
        if target_agent and fitness.get(target_agent, {}).get("tier") == "QUARANTINED":
            tier = "blocked"
            reasons.append("agent_quarantined")
            guard_item(
                item_failures,
                item_kind="triage_governance",
                item_id=pressure_id,
                work=lambda pressure_id=pressure_id, target_agent=target_agent: append_tools_governance(
                    root, "agent_dispatch_quarantined",
                    {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "target_agent": target_agent},
                ),
            )
        elif target_agent and fitness.get(target_agent, {}).get("tier") == "CALIBRATE" and tier == "auto_fix_safe":
            tier = "needs_review"
            reasons.append("agent_calibrating")
        elif target_agent and _is_fitness_stale(fitness.get(target_agent, {})) and tier == "auto_fix_safe":
            tier = "needs_review"
            reasons.append("agent_fitness_stale")
            guard_item(
                item_failures,
                item_kind="triage_governance",
                item_id=pressure_id,
                work=lambda pressure_id=pressure_id, target_agent=target_agent: append_tools_governance(
                    root, "agent_fitness_stale_downgrade",
                    {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "target_agent": target_agent},
                ),
            )
        # Plan 022 §H-6 — apply the agent's max_triage_tier ceiling AFTER
        # all path-class + fitness-status downgrades. If fitness imposes
        # a stricter ceiling than the current tier, demote.
        # Plan 023 v3 §R-4 — also pass through when fitness has NO row
        # for target_agent. The helper now caps at needs_review when
        # fitness_row is None, closing the anonymous-agent path-class-
        # only bypass.
        if target_agent:
            tier, ceiling_reasons = _enforce_max_triage_tier(
                classified_tier=tier, fitness_row=fitness.get(target_agent),
            )
            reasons.extend(ceiling_reasons)
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
        # Triage is what routes a pressure to an agent. Losing the batch to one
        # bad decision leaves every pressure after it unrouted for the cycle,
        # while the decisions already appended stay on disk unreported.
        ok, stored = guard_item(
            item_failures,
            item_kind="pressure",
            item_id=pressure_id,
            work=lambda row=row, tier=tier, target_agent=target_agent, pressure_id=pressure_id: _store_triage_decision(
                root, row, cycle_id=cycle_id, pressure_id=pressure_id, tier=tier, target_agent=target_agent,
            ),
        )
        if not ok or stored is None:
            continue
        decisions.append(stored)
    return with_item_failures(
        {"schema_version": 1, "cycle_id": cycle_id, "triaged_count": len(decisions), "decisions": decisions},
        item_failures,
    )


def _store_triage_decision(
    root: Path,
    row: dict[str, Any],
    *,
    cycle_id: str,
    pressure_id: str,
    tier: str,
    target_agent: str | None,
) -> dict[str, Any]:
    stored = append_jsonl(root / "triage" / "decisions.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "pressure_triaged", {"cycle_id": cycle_id, "pressure_event_id": pressure_id, "tier": tier, "target_agent": target_agent})
    return stored


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


# Plan 026R §E.4 — skill_birth routing kernel constant. Pre-§E.4 the
# skill_birth target was looked up in the data-driven routing table
# (a per-workspace JSON file), so a tampered routing.json or an
# operator misconfiguration could route a skill_birth pressure to
# ``agent_genesis`` — which would attempt to create a NEW AGENT for
# a request whose intent is to add a NEW SKILL. The constant pins the
# routing so the misroute is structurally impossible.
SKILL_BIRTH_ROUTING_TARGET = "skill_genesis"


def resolve_target_agent(pressure: dict[str, Any], tools_root: Path) -> str | None:
    drives = pressure.get("drives") if isinstance(pressure.get("drives"), list) else []
    # Plan 026R §E.4 — skill_birth pressures ALWAYS route to
    # skill_genesis; the kernel constant short-circuits BEFORE the
    # data-driven routing table is consulted so a tampered routing.json
    # cannot misroute the pressure.
    if "skill_birth" in drives:
        return SKILL_BIRTH_ROUTING_TARGET
    routing = _routing_table(tools_root)
    gap = str(pressure.get("capability_gap_key") or "")
    surface = gap.split(":", 1)[0] if gap else ""
    for key in (gap, surface, str(pressure.get("primitive") or "").lower()):
        if key in routing:
            return routing[key]
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

    Plan 022 §H-3 — alias-aware read. Pre-fix this read only `recorded_at`
    while fitness.py wrote `computed_at`, causing fresh fitness rows to
    register as stale and silently demote auto_fix_safe -> needs_review.
    Now reads canonical `recorded_at` first with legacy `computed_at`
    fallback. Defensive default: missing/unparseable timestamp counts
    as stale so a silent absence cannot promote auto_fix_safe.
    """
    if not row:
        return False  # no agent fitness record → caller short-circuits earlier
    recorded = row.get("recorded_at") or row.get("computed_at")
    if not isinstance(recorded, str) or not recorded.strip():
        return True
    try:
        parsed = datetime.fromisoformat(recorded.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)) > timedelta(days=threshold_days)
