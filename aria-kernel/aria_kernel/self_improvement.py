"""Plan 032 Faz 032i — the self-improvement lane: ARIA proposes changes to itself, never to its own authority.

WHY: the operator's direction — ARIA should write and improve its own code
— and the programme's rule: it must never widen its own permissions. WHAT:
signals ARIA already measures (capability gaps, funnel stalls, delivery SLO
gaps, quarantined MCP servers, failing doctor organs) become
`self_improvement` missions; a mission becomes a `self_change` proposal
whose evidence paths must lie in the kernel scope and must NOT touch an
AUTHORITY SURFACE (policy, profiles, sandbox, hooks, env, credentials).
Every proposal opens a HUMAN_REQUIRED adjudication — the irreducible
class — and `apply_engine` keeps refusing `self_change` outside the
dedicated kernel-change lane. The loop closes through people, on purpose.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

SELF_IMPROVEMENT_SOURCE_KIND = "self_improvement"
SELF_CHANGE_NEXT_ACTION = "propose_self_change"
SIGNAL_KINDS: tuple[str, ...] = ("capability_gap", "funnel_stall", "delivery_slo_gap", "mcp_quarantine", "doctor_fail")
# Where a self-change may point. Anything else is not ARIA's own code.
SELF_CHANGE_ALLOWED_PREFIXES: tuple[str, ...] = ("aria-kernel/", "tools/aria-poc/", ".github/workflows/aria-", "aria-config/", ".claude/agents/aria-")
# The authority surfaces: a self-change naming any of these is refused. These
# files decide what ARIA may do; ARIA does not get to propose their edits.
AUTHORITY_SURFACES: tuple[str, ...] = (
    "aria-kernel/aria_kernel/command_policy.py",
    "aria-kernel/aria_kernel/implementation_safety.py",
    "aria-kernel/aria_kernel/runtime_profiles.py",
    "aria-kernel/aria_kernel/data/runtime_profiles.json",
    "aria-kernel/aria_kernel/data/mcp_registry.json",
    "aria-kernel/aria_kernel/hooks.py",
    "aria-kernel/aria_kernel/claude_settings.py",
    "aria-kernel/aria_kernel/agent_env.py",
    "aria-kernel/aria_kernel/delivery_credentials.py",
    "aria-kernel/aria_kernel/gh_token_factory.py",
    "aria-kernel/aria_kernel/control.py",
    "aria-kernel/aria_kernel/self_improvement.py",
    "aria-kernel/aria_kernel/runtime_profile.py",
    "aria-kernel/aria_kernel/auto_action_gate.py",
    "aria-kernel/aria_kernel/merge_authority.py",
    "aria-kernel/aria_kernel/human_required.py",
    ".github/workflows/",
    "aria-config/genesis_policy.json",
)
SELF_CHANGE_PROPOSED_EVENT = "self_change_proposed"
SELF_CHANGE_REFUSED_EVENT = "self_change_authority_surface_refused"
DEFAULT_VALIDATION_COMMAND = "bash scripts/ci/aria-suite-run.sh"


@dataclass(frozen=True)
class Signal:
    kind: str
    key: str
    title: str
    evidence: dict[str, Any] = field(default_factory=dict)
    priority: int = 2


def authority_surface_violations(paths: list[str]) -> list[str]:
    """Paths that are outside the kernel scope or on an authority surface."""
    bad: list[str] = []
    for raw in paths:
        path = str(raw)
        while path.startswith("./"):
            path = path[2:]
        if not any(path.startswith(prefix) for prefix in SELF_CHANGE_ALLOWED_PREFIXES):
            bad.append(f"outside_kernel_scope:{path}")
            continue
        if any(path == surface or path.startswith(surface) for surface in AUTHORITY_SURFACES):
            bad.append(f"authority_surface:{path}")
    return bad


def scan_signals(*, base_dir: str | Path | None, workspace_root: str | Path) -> list[Signal]:
    root = ensure_tools_dir(base_dir)
    signals: list[Signal] = []
    try:
        from .capability_gap import latest_capability_gaps

        for gap in latest_capability_gaps(base_dir=root)[:5]:
            key = str(gap.get("capability_gap_key") or gap.get("gap_id"))
            signals.append(Signal("capability_gap", key, f"Close capability gap {key}", {"gap": {k: gap.get(k) for k in ("gap_id", "score", "capability", "kind")}}, 2))
    except Exception:  # noqa: BLE001 — a missing gap ledger is no gap
        pass
    try:
        from .funnel_health import detect_funnel_stalls
        from .knowledge_graph import rank_pressure_sources

        for stall in detect_funnel_stalls(rank_pressure_sources(workspace_root=workspace_root)):
            key = f"{stall.stage}:{stall.source_type}"
            signals.append(Signal("funnel_stall", key, f"Unblock funnel stage {stall.stage} for {stall.source_type}",
                                  {"upstream": stall.upstream, "downstream": stall.downstream}, 1))
    except Exception:  # noqa: BLE001
        pass
    try:
        from .delivery_closure import compute_delivery_closure

        summary = compute_delivery_closure(base_dir=root).summary
        for gap in summary["slo"]["gaps"]:
            if gap.startswith("verified_prs"):
                continue  # a count shortfall is not a defect to fix in code
            signals.append(Signal("delivery_slo_gap", gap, f"Delivery closure gap: {gap}", {"summary": {k: summary[k] for k in ("false_success", "duplicate_prs")}}, 1))
    except Exception:  # noqa: BLE001
        pass
    try:
        from .mcp_client import quarantined_servers

        for server in sorted(quarantined_servers(root)):
            signals.append(Signal("mcp_quarantine", server, f"MCP server {server} quarantined for errors", {"server": server}, 2))
    except Exception:  # noqa: BLE001
        pass
    try:
        from .doctor import run_doctor

        for check in run_doctor(base_dir=root, workspace_root=workspace_root).checks:
            if check.status == "fail":
                signals.append(Signal("doctor_fail", check.name, f"Doctor organ {check.name} failing: {check.reason}", {"reason": check.reason}, 1))
    except Exception:  # noqa: BLE001
        pass
    return signals


def open_self_improvement_missions(*, base_dir: str | Path | None, workspace_root: str | Path, max_new: int = 3) -> list[dict[str, Any]]:
    """Signals → missions (idempotent on source id); never more than `max_new` per call."""
    from .mission import open_mission
    from .workspace import canonical_identity

    root = ensure_tools_dir(base_dir)
    repo_hash = canonical_identity(Path(workspace_root).resolve())
    opened: list[dict[str, Any]] = []
    for signal in sorted(scan_signals(base_dir=root, workspace_root=workspace_root), key=lambda s: (s.priority, s.kind, s.key)):
        if len(opened) >= max_new:
            break
        source_id = f"{signal.kind}:{signal.key}"
        mission = open_mission(source_kind=SELF_IMPROVEMENT_SOURCE_KIND, source_id=source_id, repo_hash=repo_hash, title=signal.title[:200],
                               next_action=SELF_CHANGE_NEXT_ACTION, wake_condition={"kind": "evidence", "key": source_id},
                               priority=signal.priority, base_dir=root)
        opened.append({"mission_id": mission.get("mission_id"), "signal": signal.kind, "key": signal.key, "idempotent": bool(mission.get("idempotent"))})
    return opened


def propose_self_change(*, mission_id: str, base_dir: str | Path | None, workspace_root: str | Path, evidence_paths: list[str],
                        problem: str, proposed_change: str, validation_command: str = DEFAULT_VALIDATION_COMMAND) -> dict[str, Any]:
    """A `self_change` proposal + its HUMAN_REQUIRED adjudication. Refuses authority surfaces."""
    from .human_required import record_human_required
    from .mission import fold_mission
    from .proposal import record_proposal

    root = ensure_tools_dir(base_dir)
    mission = fold_mission(mission_id=mission_id, base_dir=root)
    if not mission or mission.get("source_kind") != SELF_IMPROVEMENT_SOURCE_KIND:
        raise GovernanceError(f"self_change_requires_self_improvement_mission:{mission_id}")
    violations = authority_surface_violations(evidence_paths)
    if violations:
        append_tools_governance(root, SELF_CHANGE_REFUSED_EVENT, {"mission_id": mission_id, "violations": violations})
        raise GovernanceError("self_change_authority_surface_refused:" + ",".join(violations))
    proposal = record_proposal(kind="self_change", title=str(mission.get("title") or mission_id)[:200], problem=problem,
                               evidence=list(evidence_paths), validation_command=validation_command, source_authority="self_improvement",
                               risk_class="kernel", proposed_change=proposed_change, status="open", base_dir=root)
    proposal_id = str(proposal.get("proposal_id"))
    digest = hashlib.sha256(proposal_id.encode("utf-8")).hexdigest()[:12]
    adjudication = record_human_required(request_id=f"self-change:{digest}", severity="high", reason="self_change_adjudication",
                                         context={"proposal_id": proposal_id, "mission_id": mission_id, "evidence": list(evidence_paths)}, base_dir=root)
    append_tools_governance(root, SELF_CHANGE_PROPOSED_EVENT, {"mission_id": mission_id, "proposal_id": proposal_id,
                                                                "human_required": adjudication.get("request_id"), "evidence": list(evidence_paths)})
    return {"proposal": proposal, "human_required": adjudication}


__all__ = ["AUTHORITY_SURFACES", "DEFAULT_VALIDATION_COMMAND", "SELF_CHANGE_ALLOWED_PREFIXES", "SELF_CHANGE_NEXT_ACTION",
           "SELF_CHANGE_PROPOSED_EVENT", "SELF_CHANGE_REFUSED_EVENT", "SELF_IMPROVEMENT_SOURCE_KIND", "SIGNAL_KINDS", "Signal",
           "authority_surface_violations", "open_self_improvement_missions", "propose_self_change", "scan_signals"]
