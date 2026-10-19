"""Plan 032 Faz 032i — the self-improvement lane: ARIA proposes changes to itself, never to its own authority.

WHY: the operator's direction — ARIA should write and improve its own code
— and the programme's rule: it must never widen its own permissions. WHAT:
signals ARIA already measures (capability gaps, funnel stalls, delivery SLO
gaps, quarantined MCP servers, failing doctor organs, and — ARIA-HIGH-122 —
the refusal and escalation CLASSES it already names: a recurring
harness-class release, an open HUMAN_REQUIRED kind, a lapsed dated waiver)
become `self_improvement` missions; a mission becomes a `self_change` proposal
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
from collections.abc import Iterable
from typing import Any, NoReturn

from .artifact_safety import scrub_text
from .doctor import DoctorCheck, DoctorReport
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
    # ARIA-MEDIUM-417 — a doctor organ failing for want of CONFIGURATION on a
    # surface ARIA may not write (a lane's env lives in `.github/workflows/`,
    # an AUTHORITY_SURFACE). Its only answer is an operator's, so it is
    # announced (the organ's FAIL, `doctor_unhealthy`, the CI step's
    # `::error`) and never minted: a `propose_self_change` for it could only
    # be refused at accept time, after its HIGH adjudication was opened.
    "config_missing": ANNOUNCE_REMEDY,
    # ARIA-LOW-550 — a doctor organ failing on a fact of the HOST the kernel
    # runs on (`HOST_ORGANS`): no `claude` binary or one below the floor, no
    # provider credential, no write-capable sandbox backend, too little disk,
    # a gateway daemon that stopped beating. The answer is an operator's on
    # that host (install, provision, restart), never a change under
    # `SELF_CHANGE_ALLOWED_PREFIXES`, so it is announced (the organ's FAIL,
    # `doctor_unhealthy`, the CI step's `::error`) and never minted.
    "host_fault": ANNOUNCE_REMEDY,
    # ARIA-HIGH-122 — a refusal or escalation CLASS the kernel already names
    # (`adaptation_signals`: a recurring harness-class release, an open
    # HUMAN_REQUIRED kind, a lapsed dated waiver). Which of the two a class
    # is born as is `ADAPTATION_SIGNAL_KINDS`' decision, below.
    "adaptation_due": SELF_CHANGE_REMEDY,
    "operator_condition": ANNOUNCE_REMEDY,
}
SIGNAL_KINDS: tuple[str, ...] = tuple(SIGNAL_REMEDIES)
SELF_CHANGE_SIGNAL_KINDS: tuple[str, ...] = tuple(kind for kind, remedy in SIGNAL_REMEDIES.items() if remedy == SELF_CHANGE_REMEDY)
# ARIA-MEDIUM-417 — the kind a FAILING doctor organ raises, when it is not
# `doctor_fail`. The doctor names what is wrong; the remedy is this module's,
# so the routing lives here, keyed by organ. `notifications` fails when the
# lane has no channel or an invalid selector — both answered in the env.
# `deadlines` fails on lapsed registry findings and operator SLAs — answered
# by an operator's adjudication, never by a change under aria-kernel/. The
# first-night dry run on aria/state f5c5c86a1 (228 lapsed HUMAN_REQUIRED
# SLAs) showed it minting a self-change mission every store would carry
# dead; it is announced like the `deadline_due` rows it summarises (the
# organ's FAIL, `doctor_unhealthy`, the CI step's `::error`).
# ARIA-LOW-550 — the organs that read the host rather than ARIA's code or
# store. The first four are `run_doctor`'s `host_checks`, run whether or not a
# store is bound; `gateway_heartbeat_fresh` reads the store but judges the
# daemon process.
HOST_ORGANS: tuple[str, ...] = ("providers", "sandbox_backend", "claude_cli", "habitat", "gateway_heartbeat_fresh")
DOCTOR_ORGAN_SIGNAL_KINDS: dict[str, str] = {
    "notifications": "config_missing",
    "deadlines": "deadline_due",
    **dict.fromkeys(HOST_ORGANS, "host_fault"),
}
# ARIA-HIGH-122 — the kind each named refusal / escalation class is born as,
# keyed `<source>:<class>` (`adaptation_signals.AdaptationClass.key`). The
# routing lives HERE, on an authority surface: ARIA reads its own refusals
# but cannot re-route one from an announcement into a mission. A class is
# `adaptation_due` (a `propose_self_change` mission) only when its answer is a
# change under `SELF_CHANGE_ALLOWED_PREFIXES` that touches no authority
# surface; a credential, a subscription, a vendor's outage, a host's binding,
# an operator's per-record decision — and a class this table does not name —
# is `operator_condition`, announced and never minted (fail closed:
# `adaptation_signal_kind`). Every harness release code and every waiver
# manifest is named here on purpose, so a new one fails
# `test_self_improvement_adaptation.EveryClassHasAWrittenDecision` instead of
# defaulting silently.
ADAPTATION_DUE = "adaptation_due"
OPERATOR_CONDITION = "operator_condition"
ADAPTATION_KINDS: tuple[str, ...] = (ADAPTATION_DUE, OPERATOR_CONDITION)
ADAPTATION_SIGNAL_KINDS: dict[str, str] = {
    # -- HUMAN_REQUIRED kinds (`context.kind`) whose RECURRENCE is the kernel's own machinery.
    "human_required:anchor_stale": ADAPTATION_DUE,         # minted requests die unclaimed: the mint/dispatch
    "human_required:lease_lifecycle": ADAPTATION_DUE,      # requests exhaust requeues on harness faults
    "human_required:plan_human_required": ADAPTATION_DUE,  # convergence ends HUMAN_REQUIRED (envelope dead, …)
    # -- HUMAN_REQUIRED kinds whose answer is a person's or a panel's, per record.
    "human_required:self_change_adjudication": OPERATOR_CONDITION,  # this loop's own question: never fed back
    "human_required:executor_escalation": OPERATOR_CONDITION,       # deliver/delete a branch, read a refusal
    "human_required:converged_plan_delivery": OPERATOR_CONDITION,   # implementation authority is the operator's
    "human_required:consensus_escalation": OPERATOR_CONDITION,      # ground truth for calibration
    "human_required:genesis_candidate": OPERATOR_CONDITION,         # panel adjudication is the answer
    "human_required:tool_promotion": OPERATOR_CONDITION,            # panel adjudication is the answer
    "human_required:human_merge_pr": OPERATOR_CONDITION,            # a person merges
    "human_required:provider_outage": OPERATOR_CONDITION,           # a vendor's state
    # A degraded adapter's answer lies in tools/aria-adapters/, outside
    # SELF_CHANGE_ALLOWED_PREFIXES: a mission for it could only be refused at
    # accept time (ARIA-MEDIUM-417). Re-routed when the operator admits that
    # surface to the proposal scope.
    "human_required:tool_degradation": OPERATOR_CONDITION,
    # -- Harness-class release codes (`release_reason`, fault_domain harness).
    "release:NATIVE_RUNTIME_PROVIDER_UNDECIDED": ADAPTATION_DUE,       # a status probe that stalls: its bound, its route
    "release:NATIVE_RUNTIME_TASK_BINDING_UNAVAILABLE": ADAPTATION_DUE,  # target revision binding refused
    "release:CLAUDE_CLI_EXIT": ADAPTATION_DUE,                         # the CLI's exit or output changed
    "release:CLAUDE_SPAWN_REFUSED": ADAPTATION_DUE,                    # the kernel's own spawn refusal
    "release:SUBMIT_TIMEOUT": ADAPTATION_DUE,                          # a bound the work outgrew
    "release:JUDGE_VERDICT_CONTRACT_VIOLATION": ADAPTATION_DUE,        # answers no longer fit the contract
    "release:SELF_CHANGE_CONTRACT_VIOLATION": ADAPTATION_DUE,
    "release:ADJUDICATION_CONTRACT_VIOLATION": ADAPTATION_DUE,
    "release:KERNEL_PROMPT_RENDERER_UNAVAILABLE": ADAPTATION_DUE,
    "release:PLANNER_DISPATCH_EXECUTOR_TIMEOUT": ADAPTATION_DUE,
    "release:PLANNER_DISPATCH_EXECUTOR_EXIT_NONZERO": ADAPTATION_DUE,
    "release:PROMPT_HASH_BINDING_MISMATCH": ADAPTATION_DUE,
    "release:EVIDENCE_VERIFICATION_UNAVAILABLE": ADAPTATION_DUE,       # git outgrew the probe's bound
    "release:EXECUTOR_UNCAUGHT_EXIT": ADAPTATION_DUE,                  # an executor body that escaped its guard
    "release:CLAUDE_CLI_AUTH_FAILURE": OPERATOR_CONDITION,             # a credential
    "release:PROVIDER_QUOTA_UNAVAILABLE": OPERATOR_CONDITION,          # a subscription
    "release:PROVIDER_UNREACHABLE": OPERATOR_CONDITION,                # a vendor's outage
    "release:ANCHOR_EXPIRED_DURING_PROVIDER_OUTAGE": OPERATOR_CONDITION,
    "release:LEASE_EXPIRED_DURING_PROVIDER_OUTAGE": OPERATOR_CONDITION,
    "release:IMPLEMENTATION_DELIVERY_UNAVAILABLE": OPERATOR_CONDITION,  # the delivery credential
    "release:IMPLEMENTATION_SIGNING_UNAVAILABLE": OPERATOR_CONDITION,   # the lane's signing identity on its host
    "release:NATIVE_RUNTIME_CONTROL_UNAVAILABLE": OPERATOR_CONDITION,   # the host cannot bind the route's controls
    "release:NATIVE_RUNTIME_ADMISSION_UNAVAILABLE": OPERATOR_CONDITION,  # no eligible provider: auth or policy
    # Under the native runtime an auth failure, a refused spawn and a CLI exit
    # all release under this one name (ci_executor), so it cannot tell a
    # credential from a changed CLI: fail closed until the executor splits it.
    "release:NATIVE_RUNTIME_EXECUTION_UNAVAILABLE": OPERATOR_CONDITION,
    "release:JUDGE_BATCH_CALL_FAILED": OPERATOR_CONDITION,             # transport, auth or credit, unsplit
    "release:HUMAN_REQUIRED_RECORD_UNAVAILABLE": OPERATOR_CONDITION,   # the store's disk or lock
    "release:DISPATCH_BUDGET_REFUSED": OPERATOR_CONDITION,             # cost policy: aria-config, an authority surface
    # -- Dated waivers (`surface_waivers.WAIVER_MANIFESTS`, manifests under
    # aria-kernel/): wire the waived surface, or re-date it with evidence.
    "waiver:surface_waiver": ADAPTATION_DUE,
    "waiver:control_waiver": ADAPTATION_DUE,
    "waiver:batch_containment_waiver": ADAPTATION_DUE,
}


def adaptation_signal_kind(class_key: str) -> str:
    """The kind a named class is born as; a class nobody routed is announced."""
    return ADAPTATION_SIGNAL_KINDS.get(class_key, OPERATOR_CONDITION)


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
    # ARIA-LOW-252 — the System One question registry: ARIA never writes its own questions.
    "aria-config/system-one-questions.json",
    # ARIA-LOW-318 review (L4) — the egress law and its transport, and the
    # secret patterns the egress backstop reads: ARIA never edits what may
    # leave the host or how.
    "aria-kernel/aria_kernel/system_one.py",
    "aria-kernel/aria_kernel/jev_runtime.py",
    "aria-kernel/aria_kernel/secret_scrub.py",
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

    for record in list_human_required(base_dir=base_dir).rows:
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


# How much of a failing organ's reason a mission title keeps (ARIA-MEDIUM-417).
DOCTOR_REASON_TITLE_CHARS = 120


def doctor_signals(check: DoctorCheck) -> list[Signal]:
    """The signals one FAILING doctor organ raises: one per cause it names,
    else one for the organ (ARIA-MEDIUM-417).

    The key is what the opener hashes into a mission id, so it is ``<organ>``
    or ``<organ>:<cause key>`` — closed vocabularies only. The title is the one
    text a minted mission keeps (it is opened with no evidence refs: the
    self-change contract asks the answer for them, ARIA-HIGH-245) and it
    reaches the self-change agent's prompt (``self_change_bridge``), so it is
    built from kernel-composed words only: a cause's KEY, never its summary —
    a summary carries the cycle's error, and a crashed cycle's error is a raw
    exception text — and an organ's reason scrubbed and bounded, which keeps
    its specifics (``breaker_tripped:cost_breaker``) without carrying a
    200-character row list."""
    kind = DOCTOR_ORGAN_SIGNAL_KINDS.get(check.name, "doctor_fail")
    head = f"Doctor organ {check.name} failing: "
    if not check.causes:
        return [Signal(kind, check.name, head + scrub_text(check.reason)[:DOCTOR_REASON_TITLE_CHARS], {"reason": check.reason}, 1)]
    return [Signal(kind, f"{check.name}:{cause.key}", head + cause.key, {"reason": check.reason, "cause": cause.key}, 1)
            for cause in check.causes]


# ARIA-LOW-587 — the families `scan_signals` reads, by name. A family is
# named on the scan's result when its reader raised a fault the reader
# DECLARES (`*_reader_faults()` next to it): a corrupt or unreadable ledger,
# a doctor organ whose probe crashed, a deadline source nobody could read.
# Anything else a reader raises is a kernel defect and raises out of the
# scan. Before, each family sat in `except Exception: pass`, so a TypeError
# in a reader, a corrupt ledger and a crashed doctor run all read as
# "nothing to improve" and the `self_improve` action reported a bare `ran`.
SCAN_FAMILIES: tuple[str, ...] = (
    "capability_gap", "funnel_stall", "delivery_slo_gap", "mcp_quarantine", "doctor_organ", "deadline_due",
    "adaptation",
)


@dataclass(frozen=True)
class UnreadableSource:
    """One family the scan could not read, and the fault it could not read it
    through: an exception CLASS name, or ``<organ>:<class>`` /
    ``<deadline source>:<class>`` where the family has parts. Never an
    exception message — it reaches the governance ledger and the lane's
    public output, and a message carries paths and row text."""

    family: str
    fault: str

    def __post_init__(self) -> None:
        if self.family not in SCAN_FAMILIES:
            raise GovernanceError(f"scan_family_unknown:{self.family}")

    @property
    def label(self) -> str:
        return f"{self.family}:{self.fault}"

    def to_dict(self) -> dict[str, str]:
        return {"family": self.family, "fault": self.fault}


@dataclass(frozen=True)
class SignalScan:
    """What one scan read: the signals, and every family it could not read."""

    signals: tuple[Signal, ...]
    unreadable: tuple[UnreadableSource, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"signals": [s.to_dict() for s in self.signals], "unreadable": [u.to_dict() for u in self.unreadable]}


def scan_signals(*, base_dir: str | Path | None, workspace_root: str | Path,
                 doctor_report: DoctorReport | None = None) -> SignalScan:
    """Every signal the store raises tonight, and every family it could not read.

    ARIA-LOW-559 — ``doctor_report`` is the report the doctor already wrote
    for this store (the live lane's doctor step, `gateway.scheduler.
    load_doctor_report`); its failing organs are read from it and the doctor
    is not run again — a second full run cost the nightly about four minutes
    (doctor 229 s, self_improve 245 s on the 2026-10-10 store). Without one
    (the gateway daemon's own `self_improve` slot, the `self-improve` CLI)
    the doctor runs here. A report of another store or another workspace is
    refused: its organs describe a different tree.

    ARIA-LOW-587 — each family absorbs only its reader's declared faults and
    names them on ``unreadable``; every other family is still read beside it.
    """
    from .capability_gap import capability_gap_reader_faults, latest_capability_gaps
    from .deadlines import read_deadlines, signal_priority
    from .delivery_closure import compute_delivery_closure, delivery_closure_reader_faults
    from .doctor import run_doctor
    from .funnel_health import detect_funnel_stalls
    from .knowledge_graph import effectiveness_reader_faults, rank_pressure_sources
    from .mcp_client import quarantine_reader_faults, quarantined_servers

    root = ensure_tools_dir(base_dir)
    if doctor_report is not None:
        if Path(doctor_report.tools_dir).resolve() != Path(root).resolve():
            raise GovernanceError(f"doctor_report_store_mismatch:{doctor_report.tools_dir!r}")
        if Path(doctor_report.workspace_root).resolve() != Path(workspace_root).resolve():
            raise GovernanceError(f"doctor_report_workspace_mismatch:{doctor_report.workspace_root!r}")
    signals: list[Signal] = []
    unreadable: list[UnreadableSource] = []
    try:
        gaps = latest_capability_gaps(base_dir=root)
    except capability_gap_reader_faults() as exc:
        unreadable.append(UnreadableSource("capability_gap", type(exc).__name__))
    else:
        # A gap its producer marked `blocked_by` (a shadow-run adapter waiting
        # on genesis adjudication) is not a self-change ARIA can make: its
        # answer is outside SELF_CHANGE_ALLOWED_PREFIXES (tools/aria-adapters/)
        # and behind a decision, so it never takes a mission slot.
        actionable = [gap for gap in gaps if not gap.get("blocked_by")]
        for gap in actionable[:5]:
            key = str(gap.get("capability_gap_key") or gap.get("gap_id"))
            signals.append(Signal("capability_gap", key, f"Close capability gap {key}", {"gap": {k: gap.get(k) for k in ("gap_id", "score", "capability", "kind")}}, 2))
    try:
        pressure = rank_pressure_sources(base_dir=root)
    except effectiveness_reader_faults() as exc:
        unreadable.append(UnreadableSource("funnel_stall", type(exc).__name__))
    else:
        for stall in detect_funnel_stalls(pressure):
            key = f"{stall.stage}:{stall.source_type}"
            signals.append(Signal("funnel_stall", key, f"Unblock funnel stage {stall.stage} for {stall.source_type}",
                                  {"upstream": stall.upstream, "downstream": stall.downstream}, 1))
    try:
        summary = compute_delivery_closure(base_dir=root).summary
    except delivery_closure_reader_faults() as exc:
        unreadable.append(UnreadableSource("delivery_slo_gap", type(exc).__name__))
    else:
        for gap in summary["slo"]["gaps"]:
            if gap.startswith("verified_prs"):
                continue  # a count shortfall is not a defect to fix in code
            signals.append(Signal("delivery_slo_gap", gap, f"Delivery closure gap: {gap}", {"summary": {k: summary[k] for k in ("false_success", "duplicate_prs")}}, 1))
    try:
        quarantined = quarantined_servers(root)
    except quarantine_reader_faults() as exc:
        unreadable.append(UnreadableSource("mcp_quarantine", type(exc).__name__))
    else:
        for server in sorted(quarantined):
            signals.append(Signal("mcp_quarantine", server, f"MCP server {server} quarantined for errors", {"server": server}, 2))
    # The doctor reports, it does not crash: `doctor._guarded` turns a probe
    # that raised into a WARN carrying the fault (`DoctorCheck.probe_fault`).
    # Such an organ's FAIL — the signal — could not be judged, so it is named
    # here by organ. A crash of the doctor run ITSELF is a defect and raises.
    report = doctor_report if doctor_report is not None else run_doctor(base_dir=root, workspace_root=workspace_root)
    for check in report.checks:
        if check.probe_fault is not None:
            unreadable.append(UnreadableSource("doctor_organ", f"{check.name}:{check.probe_fault}"))
        if check.status == "fail":
            signals.extend(doctor_signals(check))
    # ARIA-MEDIUM-128 — every deadline the kernel enforces that is lapsed or
    # inside the warning window, one signal per row, from the same reader
    # the doctor organ uses. Its remedy is ANNOUNCE (`SIGNAL_REMEDIES`):
    # the scan and the CLI carry the row; the opener mints no mission for
    # it, because a registry finding's or an operator SLA's date is not
    # answered by a change under `SELF_CHANGE_ALLOWED_PREFIXES`. The reader
    # reads every source to the end and names the ones it could not read
    # (`DeadlineReadout.undecided`), so the scan names them too.
    readout = read_deadlines(tools_dir=root, workspace_root=workspace_root)
    unreadable.extend(UnreadableSource("deadline_due", source) for source in readout.undecided)
    for row in (*readout.lapsed, *readout.due_soon):
        days = row.days_left(readout.now)
        signals.append(Signal("deadline_due", f"{row.kind}:{row.key}", f"Deadline {row.key} ({row.kind}) {'lapsed' if row.lapsed(readout.now) else 'due'} {days:+d}d: {row.consequence}",
                              row.to_dict(readout.now), signal_priority(row, readout.now)))
    # ARIA-HIGH-122 — the classes the kernel already names, one signal per
    # class, on the deadline reader's clock. Each source is read on its own,
    # so one unreadable source is named and the others still count.
    from . import adaptation_signals

    classes = list(adaptation_signals.waiver_classes(readout))
    for source, read in ((adaptation_signals.HUMAN_REQUIRED_SOURCE, lambda: adaptation_signals.human_required_classes(base_dir=root)),
                         (adaptation_signals.RELEASE_SOURCE, lambda: adaptation_signals.release_classes(base_dir=root, now=readout.now))):
        try:
            classes.extend(read())
        except adaptation_signals.adaptation_reader_faults() as exc:
            unreadable.append(UnreadableSource("adaptation", f"{source}:{type(exc).__name__}"))
    signals.extend(adaptation_signal(cls) for cls in classes)
    return SignalScan(signals=tuple(signals), unreadable=tuple(unreadable))


# What a class's count counts, per source — the title's noun.
_ADAPTATION_COUNT_NOUNS: dict[str, str] = {
    "human_required": "open HUMAN_REQUIRED records",
    "release": "harness releases this week",
    "waiver": "lapsed waivers",
}


def adaptation_signal(cls: Any) -> Signal:
    """One named class → one signal. The key is the class (`<source>:<name>`),
    so the mission id is stable however the count moves; the title is built
    from the class token and its count only — never a record's reason — since
    it is the text a minted mission keeps and the self-change prompt carries."""
    kind = adaptation_signal_kind(cls.key)
    head = "Adapt to" if kind == ADAPTATION_DUE else "Operator condition"
    return Signal(kind, cls.key, f"{head} {cls.key}: {cls.count} {_ADAPTATION_COUNT_NOUNS[cls.source]}", cls.to_dict(),
                  2 if kind == ADAPTATION_DUE else 3)


def self_change_signals(signals: Iterable[Signal]) -> list[Signal]:
    """The signals the opener may mint, in the order it mints them: only a
    kind whose remedy is a self-change, then priority, kind, key. Routing by
    remedy BEFORE priority is what keeps an announced row from taking a
    mission slot it could never fill."""
    return sorted((s for s in signals if s.remedy == SELF_CHANGE_REMEDY), key=lambda s: (s.priority, s.kind, s.key))


@dataclass(frozen=True)
class MissionOpening:
    """What one opener call did: one row per self-change signal it reached
    (``mission_id``, ``signal``, ``key``, ``idempotent``), and the families
    its scan could not read (ARIA-LOW-587) — so a night that opened nothing
    because a ledger was corrupt does not read like a night with nothing to
    improve."""

    opened: tuple[dict[str, Any], ...]
    unreadable: tuple[UnreadableSource, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"opened": list(self.opened), "unreadable": [u.to_dict() for u in self.unreadable]}


def open_self_improvement_missions(*, base_dir: str | Path | None, workspace_root: str | Path, max_new: int = 3,
                                   doctor_report: DoctorReport | None = None) -> MissionOpening:
    """Self-change signals → missions (idempotent on source id); never more than `max_new` NEW missions per call.

    ARIA-MEDIUM-417 — the budget counts what this call OPENED. A re-sighting
    of an existing mission (open or terminal: the id is a hash of the source,
    so a closed mission's source never mints again) is reported `idempotent`
    and costs nothing. Counted, it held the budget for good: on the bound
    store (2026-10-10) six self-change signals minted three missions the first
    night and none the second, and the other three never would have."""
    from .mission import open_mission
    from .workspace import canonical_identity

    root = ensure_tools_dir(base_dir)
    repo_hash = canonical_identity(Path(workspace_root).resolve())
    scan = scan_signals(base_dir=root, workspace_root=workspace_root, doctor_report=doctor_report)
    opened: list[dict[str, Any]] = []
    new = 0
    for signal in self_change_signals(scan.signals):
        if new >= max_new:
            break
        source_id = f"{signal.kind}:{signal.key}"
        mission = open_mission(source_kind=SELF_IMPROVEMENT_SOURCE_KIND, source_id=source_id, repo_hash=repo_hash, title=signal.title[:200],
                               next_action=SELF_CHANGE_NEXT_ACTION, wake_condition={"kind": "evidence", "key": source_id},
                               # ARIA-HIGH-245 — none at the mint: the self-change
                               # contract asks the answer for `evidence_paths`.
                               evidence_refs=(), priority=signal.priority, base_dir=root)
        idempotent = bool(mission.get("idempotent"))
        if not idempotent:
            new += 1
        opened.append({"mission_id": mission.get("mission_id"), "signal": signal.kind, "key": signal.key, "idempotent": idempotent})
    return MissionOpening(opened=tuple(opened), unreadable=scan.unreadable)


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


__all__ = ["ADAPTATION_DUE", "ADAPTATION_KINDS", "ADAPTATION_SIGNAL_KINDS", "ANNOUNCE_REMEDY", "AUTHORITY_SURFACES", "OPERATOR_CONDITION",
           "adaptation_signal", "adaptation_signal_kind", "DEFAULT_VALIDATION_COMMAND", "DOCTOR_ORGAN_SIGNAL_KINDS", "MissionOpening", "SCAN_FAMILIES",
           "SELF_CHANGE_ALLOWED_PREFIXES", "SignalScan", "UnreadableSource",
           "SELF_CHANGE_MISSION_REFUSALS", "SELF_CHANGE_MISSION_REFUSED_EVENT", "SELF_CHANGE_NEXT_ACTION", "SELF_CHANGE_PROPOSED_EVENT",
           "SELF_CHANGE_REFUSED_EVENT", "SELF_CHANGE_REMEDY", "SELF_CHANGE_SIGNAL_KINDS", "SELF_IMPROVEMENT_SOURCE_KIND",
           "SIGNAL_KINDS", "SIGNAL_REMEDIES", "Signal", "authority_surface_violations", "is_self_change_mission",
           "doctor_signals", "open_self_change_adjudication", "open_self_improvement_missions", "propose_self_change",
           "scan_signals", "self_change_signals"]
