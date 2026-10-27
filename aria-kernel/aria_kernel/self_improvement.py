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

import functools
import hashlib
import importlib.machinery
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Iterable
from typing import Any, Literal, NoReturn

from .agent_routing import ROUTING_INPUT_DIR
from .artifact_safety import scrub_text
from .authority_closure import BOARD_TOOLS_RELPATH, ExecutionClosure, import_closure
from .canonical_path import matches_repo_glob, repo_glob_directory
from .change_paths import read_change_paths
from .closure_reachability import CLOSURE_BASELINE_RELPATH, CLOSURE_PIN_KIND, iter_closure_pins
from .doctor import DoctorCheck, DoctorReport
from .git_containment import KERNEL_GIT_NO_HOOKS_ARGS
from .implementation_safety import KERNEL_CHECKOUT_ROOT, SandboxUnavailable, wrap_validation_in_sandbox
from .state_store_lifecycle_arcs import GIT_TIMEOUT_SECONDS
from .suite_import_roots import SUITE_IMPORT_ROOTS_RELPATH, SUITE_PYTHONPATH_ROOTS
from .surface_waivers import WAIVER_MANIFESTS, iter_waiver_entries, load_waiver_manifest
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from .validation_env import build_validation_env

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
    # a gateway daemon that stopped beating, a workspace without a package an
    # adapter's runner declares. The answer is an operator's on that host
    # (install, provision, restart), never a change under
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
# daemon process; `adapter_dependencies` (ARIA-MEDIUM-735) reads the store's
# runners but judges the workspace's installed node_modules, which `npm ci`
# on that host provides.
HOST_ORGANS: tuple[str, ...] = (
    "providers", "sandbox_backend", "claude_cli", "habitat", "gateway_heartbeat_fresh", "adapter_dependencies",
)
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


# =============================================================================
# PLAN-v2 B1 — the derived authority set ("anayasa"), ARIA-HIGH-767.
#
# WHY. What ARIA may not change about itself was written down twice and both
# copies were short: AUTHORITY_SURFACES refused a self-change only by the
# paths it DECLARED, and omitted the rollback, freeze, cap and test-collection
# modules; implementation_safety's read-only list omitted the Board runner,
# pyproject and the waiver manifests; CODEOWNERS named neither the Board
# runner nor aria-config/. One change could disarm its own rollback, narrow
# collection or add a waiver and pass its own gate (SEC-02/04/05/12, K13).
#
# WHAT. `derived_authority_set` is the ONE function. Every guard reads it:
# `implementation_safety.readonly_paths()` (the implementer room and the
# merge perimeter) projects it; `authority_surface_violations` (a proposal's
# declared paths) and `realized_diff_authority_violations` (the paths a
# branch really changes; the kernel-change lane on landing/aria-kc-l is its
# caller at pin proof and before merge, not yet on main) judge with the one
# per-path judge against it; the CODEOWNERS
# coverage and full-set invariants iterate it
# (tests/test_derived_authority_set.py).
#
# The set is CLOSED UNDER EXECUTION (`authority_closure`): every repository
# file a decider runs — through any import statement, function bodies
# included, or as a program it launches or loads by path — and every data
# file it reads by name to decide is a member too, computed from the tree;
# beside a program run by path, the standard library's names are members
# (its own directory leads sys.path). The modules that decide the set (change_paths,
# surface_waivers, closure_reachability, …) are imported by self_improvement,
# so they are members by the same rule that makes a rail's call-time inputs
# and the Board's scorer imports members; nobody lists them. And no top-level
# module name at the suite's import roots is free (`IMPORT_ROOT_MEMBERS`).
# =============================================================================
KERNEL_PACKAGE_RELPATH = "aria-kernel/aria_kernel"
_KERNEL = f"{KERNEL_PACKAGE_RELPATH}/"
# The kernel suite's collection root, as scripts/ci/aria-suite-run.sh runs it.
KERNEL_SUITE_ROOT = "aria-kernel"
# The suite's import roots are declared once, in aria-kernel/suite-import-roots,
# which scripts/ci/aria-suite-run.sh exports and suite_import_roots parses (R1).
# The Board's exam runner (`authority_closure.BOARD_TOOLS_RELPATH`). What it
# executes is computed from the tree (`authority_closure.import_closure`),
# never copied.
# The Board's own module. examination_board is B2's and does not exist yet:
# it is named by its PLANNED path so the set is complete the day B2 lands,
# rather than letting the first change after B2 edit the scorer it is judged
# by. Once it exists in a tree, its import closure joins the set like every
# other member's.
BOARD_PLANNED_MODULES: tuple[str, ...] = (f"{_KERNEL}examination_board.py",)
# The Board's seats (B2): the acceptance lane, WP-J's blind test writer and
# bug hunter (they arrive with WP-J, #2073) and the devil's-advocate seat.
# They sit under the self-change prefix `.claude/agents/aria-`, so without
# this an L3 prompt change could rewrite the Board's own seats (SEC-04).
BOARD_SEAT_PROMPTS: tuple[str, ...] = (
    ".claude/agents/aria-acceptance-*.md",
    ".claude/agents/aria-test-writer.md",
    ".claude/agents/aria-bug-hunter.md",
    ".claude/agents/aria-adversarial-judge.md",
)
# Rollback and boundary modules (B1, SEC-05): one change to a change_outcome
# resolver, self_revert's attribution or the caps parser would disarm the
# rollback that judges it, and post-merge rows arrive only after the exam.
# operator_approval and kernel_change_lane are the K13 pair; kernel_change_lane
# lands from landing/aria-kc-l and is named by its planned path.
RAIL_MODULES: tuple[str, ...] = tuple(f"{_KERNEL}{name}.py" for name in (
    "self_revert", "change_outcome", "merge_record", "self_merge_freeze", "genesis_policy",
    "autonomy_unlock", "autonomy_ladder", "risk_policy", "cost_budget", "provider_hold",
    "circuit_breaker", "git_containment", "egress_relay",
    "operator_approval", "kernel_change_lane",
))
# The test modules: what collection measures. A test module is a member (a
# change may not drop or rewrite one) but not a decider, so its imports are
# not walked (`_is_decider`): they are the code under test.
KERNEL_TESTS_GLOB = f"{KERNEL_SUITE_ROOT}/tests/**"
# The suite's single owner (R1): the script that defines what the suite runs
# and collects, and the unittest half's collector it runs by path. The
# collector sits under tests/ but decides collection, so it is a seed.
SUITE_RUNNER = "scripts/ci/aria-suite-run.sh"
SUITE_COLLECTOR = f"{KERNEL_SUITE_ROOT}/tests/_helpers/suite_shards.py"


def _import_root_members(root: str) -> tuple[str, ...]:
    """Every top-level module name at one of the suite's import roots
    (`suite_import_roots.SUITE_PYTHONPATH_ROOTS`), R3.

    Both roots precede the standard library and site-packages on sys.path
    (and the repository root is the cwd that `python3 -m` puts first), so a
    module or package at either one is imported in place of whatever bears
    its name: `aria-kernel/json.py` replaces the standard library's json in
    the suite, the collection child and every kernel process,
    `aria-kernel/pytest.py` replaces pytest, a `sitecustomize` runs before
    anything, and a repository-root `aria_kernel/__init__.py` replaces the
    whole kernel. So every name is a member in every form the importer
    loads: each loader suffix (`importlib.machinery.all_suffixes`), a
    package's `__init__.*` and the `__pycache__` beside them. The kernel
    package's own directory keeps its per-module rules; its NAME at every
    other root is a member.
    """
    head = f"{root}/" if root else ""
    kernel_name = () if root == KERNEL_SUITE_ROOT else (f"{head}aria_kernel/**",)
    return (*(f"{head}*{suffix}" for suffix in importlib.machinery.all_suffixes()),
            f"{head}*/__init__.*", f"{head}__pycache__/**", *kernel_name)


IMPORT_ROOT_MEMBERS: tuple[str, ...] = tuple(
    dict.fromkeys(glob for root in SUITE_PYTHONPATH_ROOTS for glob in _import_root_members(root)))
# Test collection (B1, SEC-12): what decides which tests run. These are
# PATTERNS, because a change that ADDS a conftest.py, a validation module or
# a test-collection override must be a member before it exists. pytest reads
# the first of pytest.ini, .pytest.ini, pyproject.toml, tox.ini and setup.cfg
# in the rootdir, so the two that outrank pyproject are members as much as it
# is, and the two after it decide once it loses its section. live_partition
# decides which collector runs a test module (ARIA-HIGH-602), so it is
# collection too. The dated waiver manifests come from their one registry
# (`surface_waivers.WAIVER_MANIFESTS`) and the closure baseline from its owner.
TEST_COLLECTION_MEMBERS: tuple[str, ...] = (
    *(f"{KERNEL_SUITE_ROOT}/{name}" for name in ("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg")),
    f"{KERNEL_SUITE_ROOT}/**/conftest.py",
    f"{_KERNEL}pytest_native_only.py",
    f"{_KERNEL}sandbox_pin_skip.py",
    f"{_KERNEL}validation*.py",
    f"{_KERNEL}live_partition.py",
    f"{_KERNEL}suite_import_roots.py",
    SUITE_IMPORT_ROOTS_RELPATH,
    SUITE_RUNNER,
    SUITE_COLLECTOR,
    *IMPORT_ROOT_MEMBERS,
    KERNEL_TESTS_GLOB,
)
# Trust-boundary renderers (PLAN-v2 §2 'Güven sınırı'): the `<untrusted_*>`
# pattern's owners. F4.0 folds the other renderers through these and they
# join the set there. `pr_tracking` joined with WP-D2: it chooses the diff and
# impact a change-intelligence envelope carries and places their tags itself
# (`text_safety.untrusted_block`), so a change to it changes what an agent
# reads as data. `judge_fanout` joined with J3: it places an `untrusted_seat`
# block per seat in the arbiter's weighing brief. A module that places a tag
# is named here, not left to a guard's import closure;
# `tests/test_derived_authority_set.py` finds every caller of
# `untrusted_block` and fails when one is missing.
TRUST_BOUNDARY_RENDERERS: tuple[str, ...] = tuple(f"{_KERNEL}{name}.py" for name in (
    "agent_invocations", "untrusted_tree", "text_safety", "pr_tracking", "judge_fanout",
))
# Routing inputs (service-expertise SE-2, SK-01): the orchestrator routing
# table is the ONE path -> agent map, and it picks the merge-time experts of
# ARIA's own implementation PRs (Gate C, expert_review_gate). A change that
# could edit it could choose its own reviewers, so the directory its owner
# reads (`agent_routing.ROUTING_INPUT_DIR`) is a member: every file there,
# including one a change ADDS. Named by its owner's constant, never copied.
ROUTING_INPUT_MEMBERS: tuple[str, ...] = (f"{ROUTING_INPUT_DIR}**",)


def _module_name_members(path: str) -> tuple[str, ...]:
    """A Python module member as every file the importer can load under its
    NAME. Python resolves `aria_kernel.self_revert` by name: a package
    `self_revert/__init__.py` or an extension `self_revert.abi3.so` beside
    `self_revert.py` is imported instead of it, and a cached
    `__pycache__/self_revert.*.pyc` stands in for its source, so a member
    named by its `.py` file alone could be replaced by adding a file.

    Inside the kernel package, which the implementer room holds read-only as
    a whole, `<stem>.*` covers the source, every extension suffix and a
    sourceless `.pyc`. Elsewhere such a glob would project to a read-only
    mount over its whole directory (`implementation_safety.readonly_mount_prefix`),
    so there the name's files are spelt by the running interpreter's own
    loader suffixes. A package's `__init__` is loaded from inside its
    directory, so it has no package form of its own.
    """
    directory, _, filename = path.rpartition("/")
    stem = filename.removesuffix(".py")
    head = f"{directory}/" if directory else ""
    if path.startswith(_KERNEL):
        files: tuple[str, ...] = (f"{head}{stem}.*",)
    else:
        files = tuple(f"{head}{stem}{suffix}" for suffix in importlib.machinery.all_suffixes())
    package = () if stem == "__init__" else (f"{head}{stem}/**",)
    return (*files, *package, f"{head}__pycache__/{stem}.*")


def _member_globs(member: str) -> tuple[str, ...]:
    """A named member as repo globs: a kernel module by its name, anything else as itself."""
    if member.endswith(".py") and member.startswith(_KERNEL):
        return _module_name_members(member)
    return (member,)


def _authority_surface_glob(surface: str) -> str:
    """An AUTHORITY_SURFACES entry as a member. The entries are prefixes: a
    directory entry covers its tree, and a file entry covers every name it
    begins (`genesis_policy.json` covers `genesis_policy.json.template`). A
    kernel module stays its path, and `_member_globs` names it by module."""
    if surface.endswith("/"):
        return f"{surface}**"
    if surface.endswith(".py") and surface.startswith(_KERNEL):
        return surface
    return f"{surface}*"


@functools.cache
def declared_authority_members() -> tuple[str, ...]:
    """The members the set NAMES, before any tree is read: AUTHORITY_SURFACES
    ∪ the Board (runner, planned module, seat prompts) ∪ the rollback and
    boundary modules ∪ test collection (the pytest ini candidates, every
    conftest.py, the collection plugins, validation*.py, the start-up hooks,
    the waiver manifests, the closure baseline, aria-kernel/tests/) ∪ the
    trust-boundary renderers, each module by its name ∪ the routing inputs
    (SE-2)."""
    named = (
        *(_authority_surface_glob(surface) for surface in AUTHORITY_SURFACES),
        f"{BOARD_TOOLS_RELPATH}/**",
        *BOARD_PLANNED_MODULES,
        *BOARD_SEAT_PROMPTS,
        *RAIL_MODULES,
        *TEST_COLLECTION_MEMBERS,
        *("/".join(manifest.relpath) for manifest in WAIVER_MANIFESTS),
        "/".join(CLOSURE_BASELINE_RELPATH),
        *TRUST_BOUNDARY_RENDERERS,
        *ROUTING_INPUT_MEMBERS,
    )
    return tuple(dict.fromkeys(glob for member in named for glob in _member_globs(member)))


def in_authority_set(path: str, authority_set: Iterable[str]) -> bool:
    """Whether a repo-relative path is a member of `authority_set`."""
    return any(matches_repo_glob(path, entry) for entry in authority_set)


def _is_decider(path: str, declared: tuple[str, ...]) -> bool:
    """Whether a Python file runs as a decider: a member that is not a test
    module, which is the code under test. A conftest.py and the suite's own
    collector (`SUITE_COLLECTOR`) under tests/ decide what is collected, so
    they are deciders."""
    if matches_repo_glob(path, KERNEL_TESTS_GLOB) and path.rpartition("/")[2] != "conftest.py" and path != SUITE_COLLECTOR:
        return False
    return path.endswith(".py") and in_authority_set(path, declared)


def _closure_seeds(root: Path, declared: tuple[str, ...]) -> list[str]:
    """The deciders in the checkout at `root` (`_is_decider`). Each is a
    declared member, so it lies under the directory its glob names
    (`canonical_path.repo_glob_directory`), or at the repository root's top
    level for a pattern that matches there; only those places are read."""
    directories: set[str] = set()
    candidates: set[Path] = set()
    for member in declared:
        directory = repo_glob_directory(member)
        if directory is None:
            candidates.add(root / member)
        elif directory:
            directories.add(directory)
        else:
            candidates.update(root.glob(member))
    for directory in directories:
        if not any(directory.startswith(f"{other}/") for other in directories):
            candidates.update((root / directory).rglob("*.py"))
    found = {path.relative_to(root).as_posix() for path in candidates if path.is_file()}
    return sorted(path for path in found if _is_decider(path, declared))


def _closure_members(closure: ExecutionClosure) -> tuple[str, ...]:
    """The closure as members: a Python file by its module name
    (`_module_name_members`), a data file a decider reads by name as itself,
    and at the directory of every file named by file name (a program that
    may run with its own directory first on sys.path, R2 of round 4) every
    standard-library module name, in each form the importer loads. The names
    are the running interpreter's own list (`sys.stdlib_module_names`), one
    brace alternative each. A suite import root already holds every name
    (`IMPORT_ROOT_MEMBERS`)."""
    stdlib = ",".join(sorted(sys.stdlib_module_names))
    program_roots = sorted({path.rpartition("/")[0] for path in closure.programs} - set(SUITE_PYTHONPATH_ROOTS))
    return (
        *(glob for path in closure.files
          for glob in (_module_name_members(path) if path.endswith(".py") else (path,))),
        *(glob for directory in program_roots for glob in _module_name_members(f"{directory}/{{{stdlib}}}.py")),
    )


def derived_authority_set(repo_root: str | Path) -> tuple[str, ...]:
    """THE authority set: repo globs (`canonical_path.matches_repo_glob`, the
    repo's one glob semantics) that no ARIA-authored change may touch.

    The named members (`declared_authority_members`) ∪ every repository
    file a decider executes or reads by name (`authority_closure.import_closure`,
    computed from `repo_root` over every import statement — function bodies
    included — and every file named by file name: the Board's scorer, the
    guards and the rails bring what they run and the decision data they
    load, including the modules that decide this set), as members
    (`_closure_members`).
    """
    root = Path(repo_root)
    declared = declared_authority_members()
    closure = import_closure(root, _closure_seeds(root, declared))
    return tuple(dict.fromkeys((*declared, *_closure_members(closure))))


@functools.cache
def kernel_authority_set() -> tuple[str, ...]:
    """The set the RUNNING kernel guards, derived from the checkout it runs from."""
    return derived_authority_set(KERNEL_CHECKOUT_ROOT)


def _authority_path_violation(path: str, authority_set: Iterable[str]) -> str | None:
    """THE per-path judge of an ARIA self-change, declared or realized: a path
    outside the kernel scope first (`outside_kernel_scope:`), then a member of
    the set (`authority_surface:`), else None."""
    if not path.startswith(SELF_CHANGE_ALLOWED_PREFIXES):
        return f"outside_kernel_scope:{path}"
    if in_authority_set(path, authority_set):
        return f"authority_surface:{path}"
    return None


def authority_surface_violations(paths: list[str]) -> list[str]:
    """The judge's verdict on each path a proposal DECLARES, against the set
    the running kernel derives."""
    authority = kernel_authority_set()
    violations: list[str] = []
    for raw in paths:
        path = str(raw)
        while path.startswith("./"):
            path = path[2:]
        verdict = _authority_path_violation(path, authority)
        if verdict is not None:
            violations.append(verdict)
    return violations


def _git_output(repo_root: Path, *args: str, stdin: bytes | None = None) -> bytes:
    """A git read the authority set's tree depends on; a failure is a refusal."""
    try:
        completed = subprocess.run(
            ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *args], cwd=str(repo_root), input=stdin, capture_output=True,
            check=False, timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GovernanceError(f"authority_set_tree_unavailable: {exc.__class__.__name__}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr.decode("utf-8", "replace").strip().splitlines() or ["?"])[0][:200]
        raise GovernanceError(f"authority_set_tree_unavailable: git {args[0]} failed: {detail}")
    return completed.stdout


# The modes a file the derivation reads may have in a tree: a regular or an
# executable file. A symlink's blob is its target's name, not the module.
_DERIVATION_BLOB_MODES = frozenset({"100644", "100755"})


def _authority_set_at(repo_root: Path, revision: str) -> tuple[str, ...]:
    """The set as `revision`'s tree derives it, read object by object.

    `git ls-tree` names the blobs and `git cat-file --batch` reads them as
    stored. No checkout and no archive is involved, so nothing the tree
    carries (a `.gitattributes` `export-ignore` or `export-subst`, a filter)
    changes what is read: an attribute merged first cannot empty BASE's
    closure (R6). Every Python file of the tree is read: the closure resolves
    an import at any of the suite's import roots, the repository root
    included (R2). So is every file under a directory that holds one: a
    walked file names data it reads under its own directory (round 4, R3).
    """
    listing = _git_output(repo_root, "ls-tree", "-r", "-z", "--full-tree", revision)
    records: list[tuple[str, str, str, str]] = []
    for record in filter(None, listing.split(b"\0")):
        meta, _, name = record.partition(b"\t")
        mode, kind, oid = meta.decode("ascii").split(" ")
        records.append((mode, kind, oid, name.decode("utf-8")))
    # A file at the repository root is in no package: it names files beside it only.
    python_directories = {path.rpartition("/")[0] for _mode, _kind, _oid, path in records if path.endswith(".py")}
    wanted: list[tuple[str, str]] = []
    for mode, kind, oid, path in records:
        directory = path.rpartition("/")[0]
        if not (path.endswith(".py") or (not directory and "" in python_directories)
                or any(other and path.startswith(f"{other}/") for other in python_directories)):
            continue
        # A tree entry is written under the extraction directory by its name, so a
        # name that is absolute or climbs out of it is refused before any
        # write (git's own fsck refuses such trees; this read does not rely
        # on it).
        if path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/")):
            raise GovernanceError(f"authority_set_tree_unavailable: {path!r} is not a relative tree path")
        if kind != "blob" or mode not in _DERIVATION_BLOB_MODES:
            raise GovernanceError(f"authority_set_tree_unavailable: {path} is a {kind} of mode {mode}")
        wanted.append((oid, path))
    stream = _git_output(repo_root, "cat-file", "--batch", stdin=b"".join(f"{oid}\n".encode("ascii") for oid, _ in wanted))
    with tempfile.TemporaryDirectory(prefix="aria-authority-set-") as tmp:
        offset = 0
        for oid, path in wanted:
            header_end = stream.index(b"\n", offset)
            got, kind, size = stream[offset:header_end].decode("ascii").split(" ")
            if got != oid or kind != "blob":
                raise GovernanceError(f"authority_set_tree_unavailable: cat-file returned {kind} {got} for {path}")
            start = header_end + 1
            target = Path(tmp, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(stream[start:start + int(size)])
            offset = start + int(size) + 1
        return derived_authority_set(tmp)


def realized_diff_authority_violations(
    repo_root: str | Path,
    *,
    base: str,
    head: str,
    board_pin_path: str | None = None,
) -> list[str]:
    """The judge's verdict on each path the diff base..head REALLY changes —
    what the branch carries, not what its proposer declared.

    The paths come from the one change reader (`change_paths`: a rename is
    its source AND its target, a deletion counts). The judge is the one the
    declared check uses (`_authority_path_violation`), so a branch can touch
    nothing its declaration could not. The set is the one BASE derives, so a
    change cannot leave the set by editing what decides it. `board_pin_path`
    is the verdict-bound Board pin path: exactly that path is exempt, matched
    exactly, and nothing under or beside it.
    """
    root = Path(repo_root)
    change = read_change_paths(root, base, head)
    authority = _authority_set_at(root, change.base_rev)
    verdicts = (_authority_path_violation(path, authority) for path in change.paths if path != board_pin_path)
    return [verdict for verdict in verdicts if verdict is not None]


# Collecting the whole kernel suite imports every test module.
TEST_COLLECTION_TIMEOUT_SECONDS = 900
# The suite owner's collect mode (scripts/ci/aria-suite-run.sh): the ids the
# suite runs, one per line, from its own two collectors.
SUITE_COLLECT_ARGV: tuple[str, ...] = ("bash", "scripts/ci/aria-suite-run.sh", "--collect")


def _collected_test_ids(root: Path, *, side: Literal["base", "head"]) -> frozenset[str]:
    """The ids of the tests the kernel suite at `root` runs, as its single
    owner collects them (`SUITE_COLLECT_ARGV`): the unittest half's leaf ids
    from the same discovery the shards run (`load_tests` and package
    `__init__` files decide) and the pytest half's node ids in both
    partitions, under the tree's own collection configuration — so a
    narrowed collection shows up as missing ids (R1: a second, private
    collector disagreed with the suite on both).

    Collection IMPORTS the tree's test modules and conftest files, and HEAD's
    are candidate code. So the child gets what a validation child may see
    (`validation_env.build_validation_env`; the suite script sets its own
    PYTHONPATH from the tree, and no inherited entry joins it) and runs in
    the validation sandbox (`implementation_safety.wrap_validation_in_sandbox`):
    no credential, no network, nothing written outside it (R8).
    """
    workspace = root.resolve()
    environment = build_validation_env(os.environ, declared={"PYTHONPATH": ""}).env
    try:
        argv = wrap_validation_in_sandbox(list(SUITE_COLLECT_ARGV), workspace_root=workspace, git=None,
                                          environment=environment)
        completed = subprocess.run(argv, cwd=str(workspace), env=environment, capture_output=True, text=True,
                                   check=False, timeout=TEST_COLLECTION_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired, SandboxUnavailable) as exc:
        raise GovernanceError(f"test_collection_unavailable:{side}:{exc.__class__.__name__}") from exc
    # BASE is the reference, so it must collect cleanly. At HEAD a failure is
    # the change's own, and what it fails to collect is reported as dropped.
    if side == "base" and completed.returncode != 0:
        raise GovernanceError(f"test_collection_unavailable:base:exit_{completed.returncode}")
    return frozenset(line for line in completed.stdout.splitlines() if line)


def _canonical_entry(entry: dict[str, Any]) -> str:
    return json.dumps(entry, sort_keys=True, separators=(",", ":"))


def _waiver_entries(root: Path) -> Counter[tuple[str, ...]]:
    """Every waiver entry in every store, structurally keyed: `(store, kind,
    surface, member, entry)` for a NESTED manifest, `(store, kind, name,
    entry)` for a FLAT one and `(store, kind, finding, symbol, entry)` for a
    closure-baseline pin, each read through its owner (`surface_waivers`,
    `closure_reachability`). A joined key let a new waiver take an existing
    one's name and vanish (R7)."""
    entries: Counter[tuple[str, ...]] = Counter()
    for manifest in WAIVER_MANIFESTS:
        store = "/".join(manifest.relpath)
        for key, entry in iter_waiver_entries(load_waiver_manifest(root, manifest), manifest):
            entries[(store, manifest.kind, *key, _canonical_entry(entry))] += 1
    baseline = "/".join(CLOSURE_BASELINE_RELPATH)
    for pin, entry in iter_closure_pins(root):
        entries[(baseline, CLOSURE_PIN_KIND, pin.finding_id, pin.symbol, _canonical_entry(entry))] += 1
    return entries


def invariants_only_grow(base_root: str | Path, head_root: str | Path) -> list[str]:
    """What a change shrinks among the invariants that judge it (B1, SEC-12).

    `test_dropped:<id>` for each test id collected at base and not at head
    (collected ids base ⊆ head), and `waiver_added:<json key>` for each waiver
    entry — in a registered manifest or the closure baseline — that head
    holds and base does not hold verbatim (waivers head ⊆ base, as
    multisets: a re-dated waiver is a new waiver). Both trees are collected
    in the validation sandbox (`_collected_test_ids`).
    """
    base, head = Path(base_root), Path(head_root)
    head_ids = _collected_test_ids(head, side="head")
    violations = [f"test_dropped:{test_id}"
                  for test_id in sorted(_collected_test_ids(base, side="base") - head_ids)]
    added = _waiver_entries(head) - _waiver_entries(base)
    violations.extend(f"waiver_added:{json.dumps(list(key[:-1]))}" for key in sorted(added.elements()))
    return violations


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
        except adaptation_signals.PartiallyUnreadableAdaptation as partial:
            # ARIA-LOW-597 at this seam: the readable records still count,
            # and the unreadable ones are named beside them — the deadline
            # reader's PartiallyUnreadableSource doctrine, carried through.
            classes.extend(partial.classes)
            unreadable.append(UnreadableSource("adaptation", f"{source}:{','.join(partial.undecided)}"))
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
           "BOARD_PLANNED_MODULES", "BOARD_SEAT_PROMPTS", "KERNEL_PACKAGE_RELPATH", "KERNEL_SUITE_ROOT",
           "IMPORT_ROOT_MEMBERS", "KERNEL_TESTS_GLOB", "RAIL_MODULES", "ROUTING_INPUT_MEMBERS", "SUITE_COLLECT_ARGV", "SUITE_COLLECTOR", "SUITE_RUNNER",
           "TEST_COLLECTION_MEMBERS", "TEST_COLLECTION_TIMEOUT_SECONDS", "TRUST_BOUNDARY_RENDERERS",
           "declared_authority_members", "derived_authority_set", "in_authority_set", "invariants_only_grow",
           "kernel_authority_set",
           "realized_diff_authority_violations",
           "adaptation_signal", "adaptation_signal_kind", "DEFAULT_VALIDATION_COMMAND", "DOCTOR_ORGAN_SIGNAL_KINDS", "MissionOpening", "SCAN_FAMILIES",
           "SELF_CHANGE_ALLOWED_PREFIXES", "SignalScan", "UnreadableSource",
           "SELF_CHANGE_MISSION_REFUSALS", "SELF_CHANGE_MISSION_REFUSED_EVENT", "SELF_CHANGE_NEXT_ACTION", "SELF_CHANGE_PROPOSED_EVENT",
           "SELF_CHANGE_REFUSED_EVENT", "SELF_CHANGE_REMEDY", "SELF_CHANGE_SIGNAL_KINDS", "SELF_IMPROVEMENT_SOURCE_KIND",
           "SIGNAL_KINDS", "SIGNAL_REMEDIES", "Signal", "authority_surface_violations", "is_self_change_mission",
           "doctor_signals", "open_self_change_adjudication", "open_self_improvement_missions", "propose_self_change",
           "scan_signals", "self_change_signals"]
