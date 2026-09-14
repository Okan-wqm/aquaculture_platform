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

`propose_self_change` is the AUTHORITY BOUNDARY for the answer, judged at
accept time against the mission as it is then: the same discriminator the
mint uses (`is_self_change_mission`), plus the mission's state and its open
adjudication. A second in-flight request for one mission is routine (the
scheduler never moves a DISCOVERED mission; the queue de-duplicates per
pending item), so the second accepted answer is refused by name
(`SELF_CHANGE_MISSION_REFUSALS`) and the mission — including an operator's
`next_action` — is left exactly as it was.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NoReturn

from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

SELF_IMPROVEMENT_SOURCE_KIND = "self_improvement"
SELF_CHANGE_NEXT_ACTION = "propose_self_change"
# ARIA-MEDIUM-128 — a signal's REMEDY is decided by its kind, here, once. The
# opener mints a `propose_self_change` mission only for a kind whose answer
# is a change to ARIA's own code (`SELF_CHANGE_ALLOWED_PREFIXES`): that is the
# only contract the mission's prompt (`mission_dispatch._self_change_contract`)
# can dispatch, and its accepted answer mints a HUMAN_REQUIRED adjudication.
# A `deadline_due` row names a registry finding's or an operator SLA's date —
# an answer nobody can write in aria-kernel/ — so it is ANNOUNCED (doctor,
# daily report, `self-improve scan`) and never becomes a mission: on the live
# checkout 132 lapsed registry rows would otherwise fill the opener's budget
# every night and starve the `mcp_quarantine` row beside them.
SELF_CHANGE_REMEDY = "self_change"
ANNOUNCE_REMEDY = "announce"
SIGNAL_REMEDIES: dict[str, str] = {
    "capability_gap": SELF_CHANGE_REMEDY,
    "funnel_stall": SELF_CHANGE_REMEDY,
    "delivery_slo_gap": SELF_CHANGE_REMEDY,
    "mcp_quarantine": SELF_CHANGE_REMEDY,
    "doctor_fail": SELF_CHANGE_REMEDY,
    "deadline_due": ANNOUNCE_REMEDY,
}
SIGNAL_KINDS: tuple[str, ...] = tuple(SIGNAL_REMEDIES)
SELF_CHANGE_SIGNAL_KINDS: tuple[str, ...] = tuple(kind for kind, remedy in SIGNAL_REMEDIES.items() if remedy == SELF_CHANGE_REMEDY)
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
    # ARIA-MEDIUM-066 — decides what a validation child may see; the same
    # class of envelope as agent_env, so a self-change may not re-admit the
    # store bindings or a credential to its own test runs.
    "aria-kernel/aria_kernel/validation_env.py",
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
# The mission-side refusals of `propose_self_change`, one governance kind
# with the reason in `details.reason` (a member of SELF_CHANGE_MISSION_REFUSALS):
# the proposal is judged against the MISSION as it is at accept time, not as
# it was when the request was minted. Two in-flight requests for one mission
# are routine — the scheduler never moves a DISCOVERED mission, and the queue
# de-duplicates per pending item, not per mission — so the second accepted
# answer must be refused here, by name, and leave the mission untouched.
SELF_CHANGE_MISSION_REFUSED_EVENT = "self_change_mission_refused"
SELF_CHANGE_MISSION_REFUSALS: tuple[str, ...] = (
    "self_change_mission_terminal",           # a terminal mission cannot be parked afterwards
    "self_change_mission_operator_held",      # HUMAN_REQUIRED: the pointer is a person's sentence
    "self_change_mission_moved_on",           # the pointer is no longer SELF_CHANGE_NEXT_ACTION
    "self_change_adjudication_already_open",  # an open self_change_adjudication names this mission
)
DEFAULT_VALIDATION_COMMAND = "bash scripts/ci/aria-suite-run.sh"


@dataclass(frozen=True)
class Signal:
    kind: str
    key: str
    title: str
    evidence: dict[str, Any] = field(default_factory=dict)
    priority: int = 2

    def __post_init__(self) -> None:
        # A kind without a remedy cannot be routed; refusing it at
        # construction keeps `SIGNAL_REMEDIES` the one place a kind is born.
        if self.kind not in SIGNAL_REMEDIES:
            raise GovernanceError(f"signal_kind_unknown:{self.kind}")

    @property
    def remedy(self) -> str:
        return SIGNAL_REMEDIES[self.kind]

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "key": self.key, "title": self.title, "evidence": self.evidence,
                "priority": self.priority, "remedy": self.remedy}


def is_self_change_mission(mission_row: dict[str, Any]) -> bool:
    """The discriminator both doors dispatch on: source kind AND pointer.

    Both, because either alone lies: a self_improvement mission whose pointer
    an adjudication (or the operator) replaced must not receive another
    proposal, and a foreign mission carrying this pointer is a producer
    defect. The mission branch reads it at the mint
    (`mission_dispatch._self_change_contract`) and `propose_self_change`
    reads it again at accept time, because the mission can move between the
    two — a second in-flight request for the same mission is routine.
    """
    return (str(mission_row.get("source_kind") or "") == SELF_IMPROVEMENT_SOURCE_KIND
            and str(mission_row.get("next_action") or "") == SELF_CHANGE_NEXT_ACTION)


def open_self_change_adjudication(*, mission_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    """The OPEN `self_change_adjudication` that names this mission, if any."""
    from .human_required import list_human_required

    for record in list_human_required(base_dir=base_dir):
        context = record.get("context") if isinstance(record.get("context"), dict) else {}
        if record.get("reason") == "self_change_adjudication" and str(context.get("mission_id") or "") == mission_id:
            return record
    return None


def _refuse_mission(root: Path, *, reason: str, mission_id: str, mission: dict[str, Any], detail: str) -> NoReturn:
    """Refuse at the authority boundary: one governance row, then the error the bridge records."""
    if reason not in SELF_CHANGE_MISSION_REFUSALS:
        raise GovernanceError(f"self_change_mission_refusal_unknown:{reason}")
    append_tools_governance(root, SELF_CHANGE_MISSION_REFUSED_EVENT, {
        "mission_id": mission_id, "reason": reason, "state": mission.get("state"),
        "next_action": mission.get("next_action"), "detail": detail,
    })
    raise GovernanceError(f"{reason}:{mission_id}:{detail}")


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

        for stall in detect_funnel_stalls(rank_pressure_sources(base_dir=root)):
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
    try:
        # ARIA-MEDIUM-128 — every deadline the kernel enforces that is lapsed or
        # inside the warning window, one signal per row, from the same reader
        # the doctor organ uses. Its remedy is ANNOUNCE (`SIGNAL_REMEDIES`):
        # the scan and the CLI carry the row; the opener mints no mission for
        # it, because a registry finding's or an operator SLA's date is not
        # answered by a change under `SELF_CHANGE_ALLOWED_PREFIXES`.
        from .deadlines import read_deadlines, signal_priority

        readout = read_deadlines(tools_dir=root, workspace_root=workspace_root)
        for row in (*readout.lapsed, *readout.due_soon):
            days = row.days_left(readout.now)
            signals.append(Signal("deadline_due", f"{row.kind}:{row.key}", f"Deadline {row.key} ({row.kind}) {'lapsed' if row.lapsed(readout.now) else 'due'} {days:+d}d: {row.consequence}",
                                  row.to_dict(readout.now), signal_priority(row, readout.now)))
    except Exception:  # noqa: BLE001
        pass
    return signals


def self_change_signals(signals: list[Signal]) -> list[Signal]:
    """The signals the opener may mint, in the order it mints them: only a
    kind whose remedy is a self-change, then priority, kind, key. Routing by
    remedy BEFORE priority is what keeps an announced row from taking a
    mission slot it could never fill."""
    return sorted((s for s in signals if s.remedy == SELF_CHANGE_REMEDY), key=lambda s: (s.priority, s.kind, s.key))


def open_self_improvement_missions(*, base_dir: str | Path | None, workspace_root: str | Path, max_new: int = 3) -> list[dict[str, Any]]:
    """Self-change signals → missions (idempotent on source id); never more than `max_new` per call."""
    from .mission import open_mission
    from .workspace import canonical_identity

    root = ensure_tools_dir(base_dir)
    repo_hash = canonical_identity(Path(workspace_root).resolve())
    opened: list[dict[str, Any]] = []
    for signal in self_change_signals(scan_signals(base_dir=root, workspace_root=workspace_root)):
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
    """A `self_change` proposal + its HUMAN_REQUIRED adjudication.

    Refuses, before any write, authority surfaces in the evidence AND every
    mission the bridge's park would wrong (`SELF_CHANGE_MISSION_REFUSALS`).
    """
    from .human_required import record_human_required
    from .mission import OPERATOR_HELD_STATES, TERMINAL_STATES, fold_mission
    from .proposal import record_proposal

    root = ensure_tools_dir(base_dir)
    mission = fold_mission(mission_id=mission_id, base_dir=root)
    if not mission or mission.get("source_kind") != SELF_IMPROVEMENT_SOURCE_KIND:
        raise GovernanceError(f"self_change_requires_self_improvement_mission:{mission_id}")
    # Every mission-side refusal happens BEFORE any write, against the
    # mission AS IT IS NOW. The bridge parks the mission in HUMAN_REQUIRED
    # after the proposal, so each guard names a mission that park would
    # wrong: a terminal one cannot move; an operator-held one carries a
    # person's sentence the park would overwrite; one whose pointer moved on
    # was already answered (or re-pointed by the operator); one with an open
    # adjudication would get a second proposal for the same signal.
    state = str(mission.get("state") or "")
    if state in TERMINAL_STATES:
        _refuse_mission(root, reason="self_change_mission_terminal", mission_id=mission_id, mission=mission, detail=state)
    if state in OPERATOR_HELD_STATES:
        _refuse_mission(root, reason="self_change_mission_operator_held", mission_id=mission_id, mission=mission, detail=state)
    if not is_self_change_mission(mission):
        _refuse_mission(root, reason="self_change_mission_moved_on", mission_id=mission_id, mission=mission,
                        detail=repr(mission.get("next_action")))
    standing = open_self_change_adjudication(mission_id=mission_id, base_dir=root)
    if standing is not None:
        _refuse_mission(root, reason="self_change_adjudication_already_open", mission_id=mission_id, mission=mission,
                        detail=str(standing.get("request_id")))
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


__all__ = ["ANNOUNCE_REMEDY", "AUTHORITY_SURFACES", "DEFAULT_VALIDATION_COMMAND", "SELF_CHANGE_ALLOWED_PREFIXES",
           "SELF_CHANGE_MISSION_REFUSALS", "SELF_CHANGE_MISSION_REFUSED_EVENT", "SELF_CHANGE_NEXT_ACTION", "SELF_CHANGE_PROPOSED_EVENT",
           "SELF_CHANGE_REFUSED_EVENT", "SELF_CHANGE_REMEDY", "SELF_CHANGE_SIGNAL_KINDS", "SELF_IMPROVEMENT_SOURCE_KIND",
           "SIGNAL_KINDS", "SIGNAL_REMEDIES", "Signal", "authority_surface_violations", "is_self_change_mission",
           "open_self_change_adjudication", "open_self_improvement_missions", "propose_self_change", "scan_signals",
           "self_change_signals"]
