from __future__ import annotations

import errno
import json
import subprocess
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .feedback import derive_pressure
from .ledger import verify_index_hashes, write_index
from .learning import run_learning_pass, run_learning_post_evidence_closure, run_learning_pre_cycle
from .github_adapters import select_github_adapter
from .mission import adopt_task_candidates, assert_cycle_closure
from .mission_reconcile import reconcile_missions
from .worker_dispatch import reap_expired_assignment_claims
from .workspace import WorkspacePaths, ensure_workspace, repo_hash, workspace_paths
from .discovery import run_discovery
from .cycle_diff import run_cycle_diff
from .cycle_progress import emit_progress
from .impact_graph import cycle_service_examination
from .memory import decay_stale_beliefs_by_age, update_memory
from .observability import generate_observability_dashboard, record_cycle_metrics
from .runtime_artifacts import read_runs_for_cycle, verify_artifacts
from .pressure import run_pressure
from .genesis_policy import load_policy
from .reflection import run_reflection
from .human_required import (
    sweep_consensus_uncertainties_for_human_required,
    sweep_lease_lifecycle_for_human_required,
)
from .human_required_adjudication import sweep_human_required_adjudications
from .agent_invocations import reap_stale_claims
from .calibration import recommend_calibration
from .goldset import propose_goldsets_for_labelled_tools
from .judge_calibration import compute_judge_calibration
from .proactive_priority import compute_proactive_priorities
from .runtime_profile import ACTION_PERMISSIONS, get_profile
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding, list_tools, register_tool, utc_now, update_tools_index
from .tool_runner import run_tool
from .ledger import append_declared_jsonl


# Plan 024 v3 followup §E (ORPHAN-LOW-057) — typed cycles.jsonl row schema.
#
# Pre-fix two writers (started + completed) emitted dict literals that
# omitted `status` entirely; the aborted-by-pre-phase + ARIA_STOP paths
# returned an in-memory dict but never appended a terminal row to
# cycles.jsonl, leaving those cycles "open forever" against
# integrity._verify_cycle_lifecycle.
#
# Post-fix this dataclass is the single constructor for cycles.jsonl
# rows. The `Literal` type makes `status: CycleStatus` compile-time
# enforced under mypy strict; the four convenience factories below pin
# each terminal event to its canonical status so a future caller cannot
# drift the discriminated-union shape.
CycleStatus = Literal["started", "completed", "failed", "stopped", "aborted"]

CYCLE_TERMINAL_STATUSES: tuple[CycleStatus, ...] = (
    "completed", "failed", "stopped", "aborted",
)
CYCLE_ROW_SCHEMA_VERSION = 3


@dataclass(frozen=True, slots=True)
class CycleRow:
    """Plan 024 v3 followup §E — typed cycles.jsonl row.

    Frozen + slotted so the writer cannot mutate the row after
    construction; `Literal` on `status` rejects any string outside the
    canonical 5-value union at static-check time.
    """

    schema_version: int
    at: str
    cycle_id: str
    event: str
    status: CycleStatus
    git_head_sha_at_cycle: str | None = None
    tool_decision_count: int | None = None
    tool_governance_decision_count: int | None = None

    def to_jsonl(self) -> dict[str, Any]:
        # Drop None-valued optionals so ledger-hash stays byte-stable
        # for rows that legitimately omit them (started rows have no
        # decision counts; legacy completed rows omit git head sha).
        return {k: v for k, v in asdict(self).items() if v is not None}


def _started_cycle_row(*, cycle_id: str) -> dict[str, Any]:
    """Plan 024 §E — single constructor for the started cycles.jsonl row.

    Pre-fix the writer emitted a dict literal that omitted `status`.
    The Literal-typed dataclass makes the wrong shape impossible.
    """
    return CycleRow(
        schema_version=CYCLE_ROW_SCHEMA_VERSION,
        at=utc_now(),
        cycle_id=cycle_id,
        event="started",
        status="started",
    ).to_jsonl()


def _terminal_cycle_row(
    *,
    cycle_id: str,
    event: str,
    status: CycleStatus,
    decision_count: int | None = None,
    git_head_sha_at_cycle: str | None = None,
) -> dict[str, Any]:
    """Plan 024 §E — single constructor for every terminal cycles.jsonl
    row. Callers pass the (event, status) pair explicitly; the four
    convenience wrappers below pin each terminal event to its canonical
    status so the (event, status) discriminated union cannot drift.
    """
    if status not in CYCLE_TERMINAL_STATUSES:
        raise ValueError(
            f"non-terminal status passed to terminal row: {status!r}",
        )
    return CycleRow(
        schema_version=CYCLE_ROW_SCHEMA_VERSION,
        at=utc_now(),
        cycle_id=cycle_id,
        event=event,
        status=status,
        git_head_sha_at_cycle=git_head_sha_at_cycle,
        tool_decision_count=decision_count,
        tool_governance_decision_count=decision_count,
    ).to_jsonl()


def _completed_event(
    cycle_id: str,
    decision_count: int,
    *,
    git_head_sha_at_cycle: str | None = None,
) -> dict[str, Any]:
    return _terminal_cycle_row(
        cycle_id=cycle_id,
        event="completed",
        status="completed",
        decision_count=decision_count,
        git_head_sha_at_cycle=git_head_sha_at_cycle,
    )


def _stopped_event(
    cycle_id: str,
    *,
    git_head_sha_at_cycle: str | None = None,
) -> dict[str, Any]:
    return _terminal_cycle_row(
        cycle_id=cycle_id,
        event="stopped",
        status="stopped",
        git_head_sha_at_cycle=git_head_sha_at_cycle,
    )


def _aborted_event(
    cycle_id: str,
    *,
    git_head_sha_at_cycle: str | None = None,
    decision_count: int | None = None,
) -> dict[str, Any]:
    return _terminal_cycle_row(
        cycle_id=cycle_id,
        event="aborted",
        status="aborted",
        decision_count=decision_count,
        git_head_sha_at_cycle=git_head_sha_at_cycle,
    )


def _failed_event(
    cycle_id: str,
    *,
    git_head_sha_at_cycle: str | None = None,
    decision_count: int | None = None,
) -> dict[str, Any]:
    return _terminal_cycle_row(
        cycle_id=cycle_id,
        event="failed",
        status="failed",
        decision_count=decision_count,
        git_head_sha_at_cycle=git_head_sha_at_cycle,
    )


def run_cycle(paths: WorkspacePaths | None = None, **kwargs: Any) -> dict[str, object]:
    if paths is None:
        return run_enterprise_cycle(**kwargs)
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    emitted = derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)

    cycle_id = datetime.now(timezone.utc).strftime("cyc-%Y%m%dT%H%M%SZ")
    git_head_sha_at_cycle = _git_head_sha(paths.repo_root)
    learning = run_learning_pass(paths, cycle_id=cycle_id)
    state = {
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "repo_root": str(paths.repo_root),
        "workspace_root": str(paths.workspace_root),
        "feedback_pressure_emitted": len(emitted),
        "learning": learning,
        "schema_version": 2,
    }
    _write_workspace_cycle_artifact(paths, state)
    return state


# =====================================================================
# The cycle pipeline, declared as data.
#
# RC-1 tier-1, closing ORPHAN-CRITICAL-498 and ORPHAN-HIGH-505 together
# because they are one defect seen from two sides.
#
# WHAT WAS HERE. `DEFAULT_CYCLE_PHASES` named five phases and
# `SUPPORTED_CYCLE_PHASES` added four more, and their only job was to
# validate the `run_phases` / `pre_tool_phases` keyword arguments. No
# production caller passed either one, so four safety-relevant phases —
# the architecture spine gate, the validation matrix, and the PR
# lifecycle perimeter — were implemented, unit-tested, and never
# executed. Optional safety is not safety.
#
# The constants were also wrong about the cycle they claimed to
# describe: the body ran fifteen phases, not five, and the one name that
# overlapped ('discover') did not even match what the body emitted
# ('discovery'). A constant that names a pipeline's steps is either that
# pipeline's SSoT or it is misinformation; this one had the appearance
# of authority and none of the duties.
#
# WHAT IS HERE NOW. One ordered tuple, `CYCLE_PHASES`, whose entries are
# the phases the cycle actually runs. Each entry carries:
#
#   * the STAGE it belongs to, replacing the two kwargs. A phase runs
#     before tools or after them because the table says so, not because
#     a caller picked a keyword argument;
#   * a PRECONDITION drawn from a closed set (`CYCLE_PRECONDITIONS`).
#     "The caller did not ask for this phase" is no longer a category,
#     so a phase cannot be silently absent — an unmet precondition
#     produces a recorded skip naming the precondition;
#   * an ERROR POLICY, because the body already had three different ones
#     and they were expressed only by the presence or absence of a
#     `post_tool_failure is None` guard on each block.
#
# The kwargs and both constants are DELETED, not kept as a compatibility
# seam. A second entrance into the same phases is the cause of this
# finding, and the constants existed only to validate that entrance;
# removing either half alone would leave a dangling other half.
# =====================================================================

# Where a phase sits relative to the two structural boundaries of a
# cycle: discovery (which can end the cycle early) and the tool loop.
# `preflight` runs before discovery because its question is whether there is a
# cycle to run at all — not what changed, but whether the tree holding the
# answer is the one the last published state left behind. Every later stage,
# discovery included, reads or writes that tree.
PhaseStage = Literal["preflight", "discovery", "pre_tool", "tools", "post_tool"]
CYCLE_STAGES: tuple[PhaseStage, ...] = ("preflight", "discovery", "pre_tool", "tools", "post_tool")

# Which pipeline a phase belongs to. ``standard`` is the nightly cycle;
# ``burn_in`` is the observe burn-in lane, which pre-collapse was a THIRD
# hand-rolled loop in burn_in.py importing this module's private event
# factories and re-implementing the started/terminal ledger discipline.
# A burn-in cycle proves that no claim / tool-run / PR / merge surface
# was touched, so the action-bearing phases simply do not carry the
# ``burn_in`` mode — the no-action property is a column of this table
# rather than a promise in a docstring.
CycleMode = Literal["standard", "burn_in"]
CYCLE_MODES: tuple[CycleMode, ...] = ("standard", "burn_in")

# What happens when a phase runner raises. These four are not a design
# choice made here — they are the four behaviours the cycle body already
# had, each previously encoded as the shape of an ad-hoc try/except.
#
#   propagate           — no handler; the exception ends the cycle.
#                         Discovery and the tool loop: if they cannot
#                         run there is no cycle to report on.
#   halt_sequence       — the failure is recorded and every LATER
#                         halt_sequence phase is skipped. This is the
#                         `if post_tool_failure is None:` chain.
#   record_and_continue — runs even after an upstream failure, and its
#                         own failure is recorded. Bookkeeping phases
#                         (learning closure, metrics, dashboard) must
#                         still close out a failed cycle.
#   swallow             — the error is absorbed and the phase reports
#                         degraded. Reserved for phases that are pure
#                         operator convenience and must never be able to
#                         fail a cycle.
PhaseErrorPolicy = Literal["propagate", "halt_sequence", "record_and_continue", "swallow"]


@dataclass(frozen=True, slots=True)
class PhaseContext:
    """Everything a phase runner is allowed to read.

    One object rather than a long parameter list, so a phase cannot
    quietly reach for cycle-local state the table never promised it —
    and so adding a phase never means widening a dispatch signature.

    ``results`` and ``outcomes`` are deliberately mutable and owned by
    the driver: they are how a later phase reads an earlier one (
    reflection needs judge calibration; metrics needs the tool run
    summary). Storing that once and reading it back is what keeps the
    cycle from carrying a second, parallel copy of its own state.
    """

    cycle_id: str
    workspace_root: Path
    base_dir: Path
    workspace: WorkspacePaths
    plan_id: str | None
    shadow_only: bool
    defer_reflection: bool
    snapshot_mode: str
    profile: str
    cycle_started_at: datetime
    started_monotonic: float
    results: dict[str, Any]
    outcomes: dict[str, dict[str, Any]]
    # Defaulted (and therefore last): pre-mode tests and callers build the
    # context without it, and "standard" is exactly what they meant.
    mode: str = "standard"

    def result(self, phase_name: str) -> Any:
        """The payload a completed phase returned, or None if it did not run."""
        return self.results.get(phase_name)


@dataclass(frozen=True, eq=False, slots=True)
class PhasePrecondition:
    """A named, reusable answer to "may this phase run in this cycle?".

    Identity-compared (``eq=False``) so the closed set below is a set of
    THESE objects: a phase declaring a freshly-built lookalike is
    rejected by ``_assert_pipeline_is_well_formed`` at import time rather
    than quietly widening the vocabulary.
    """

    name: str
    test: Callable[[PhaseContext], bool]

    def satisfied_by(self, context: PhaseContext) -> bool:
        return self.test(context)


def _always(_context: PhaseContext) -> bool:
    return True


def _writes_permitted(context: PhaseContext) -> bool:
    return not context.shadow_only


def _reflection_not_deferred(context: PhaseContext) -> bool:
    return not context.defer_reflection


def _plan_id_present(context: PhaseContext) -> bool:
    return context.plan_id is not None


def _profile_permits_pr_open(context: PhaseContext) -> bool:
    """Derived from the same table `open_pr_for_action` enforces.

    THIS DEVIATES FROM THE PLAN, deliberately, and the deviation is the
    difference between a live nightly and a nightly that reports failure
    every night. The plan specified `profile_in(
    PROFILES_WITH_ACTION_AUTHORITY)`, which is the UNION over every
    action kind — {standard, strict, autonomous}. But `pr_open` is
    permitted to {strict, autonomous} only, and `open_pr_for_action`
    calls `enforce_profile_for_action('pr_open')` on entry. Gating the
    phase on the union would let it run under `standard` (the default
    profile) and take a GovernanceError per approved proposal, marking
    the phase — and therefore the cycle — failed, on a lane where
    nothing is actually wrong.

    Reading `ACTION_PERMISSIONS['pr_open']` means the phase's gate and
    the callee's guard cannot disagree: they are the same table. A
    literal profile set here would rot the first time that table moved,
    which is exactly how the hardcoded `profile == "autonomous"` checks
    that ORPHAN-CRITICAL-420 S2 removed came to be wrong.
    """
    return context.profile in ACTION_PERMISSIONS["pr_open"]


ALWAYS = PhasePrecondition("always", _always)
WRITES_PERMITTED = PhasePrecondition("writes_permitted", _writes_permitted)
REFLECTION_NOT_DEFERRED = PhasePrecondition("reflection_not_deferred", _reflection_not_deferred)
PLAN_ID_PRESENT = PhasePrecondition("plan_id_present", _plan_id_present)
PROFILE_PERMITS_PR_OPEN = PhasePrecondition("profile_permits:pr_open", _profile_permits_pr_open)

# The closed set. A phase may only declare one of these, enforced at
# import time. Widening the vocabulary is therefore a deliberate edit
# here rather than an inline lambda nobody reviews.
#
# `not_discovery_only` is ABSENT ON PURPOSE, though the plan named it: a
# discovery-only cycle returns before the pre_tool stage is reached, so
# every post-discovery phase already runs with `discovery_only` false.
# Declaring it would put a condition in the table that is structurally
# always true — the same species of misinformation this table replaces.
CYCLE_PRECONDITIONS: tuple[PhasePrecondition, ...] = (
    ALWAYS,
    WRITES_PERMITTED,
    REFLECTION_NOT_DEFERRED,
    PLAN_ID_PRESENT,
    PROFILE_PERMITS_PR_OPEN,
)


@dataclass(frozen=True, slots=True)
class CyclePhase:
    """One step of the cycle, and everything the driver needs to run it.

    ``state_key`` is the legacy top-level key in the returned state dict
    that this phase's payload lands under. The projection is declared
    here so the state dict is DERIVED from the phase results rather than
    assembled beside them — one storage, two views.

    ``absent`` builds the payload recorded when the phase does not run.
    A factory rather than a value so two skipped cycles cannot end up
    sharing one dict, and per-phase because the shapes genuinely differ
    (reflection's absence is ``None``, and the Plan ARIA-V3.3 §2b
    deferred-reflection contract the autonomy orchestrator relies on reads
    exactly that).
    """

    name: str
    stage: PhaseStage
    runner: Callable[[PhaseContext], Any]
    precondition: PhasePrecondition = ALWAYS
    on_error: PhaseErrorPolicy = "halt_sequence"
    state_key: str | None = None
    absent: Callable[[], Any] = dict
    error_payload: Callable[[PhaseContext, Exception], Any] | None = None
    # The pipelines this phase belongs to. Default is standard-only, so a
    # newly added phase can never leak into the burn-in lane by omission —
    # joining burn_in is an explicit declaration reviewed on this table.
    modes: frozenset[str] = frozenset({"standard"})


def build_phase_context(
    *,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: Path,
    workspace: WorkspacePaths | None = None,
    plan_id: str | None = None,
    shadow_only: bool = False,
    defer_reflection: bool = False,
    snapshot_mode: str = "committed",
    mode: str = "standard",
    cycle_started_at: datetime | None = None,
    started_monotonic: float | None = None,
) -> PhaseContext:
    """The ONE constructor for a PhaseContext, used by production and tests.

    RC-3's finding was that four defects survived every green suite because
    the fixtures were shaped unlike production — a request dict carrying a
    field 15 of 17 mint paths omit, a timeout of 600 where production uses
    1800. The cure is that there is no second way to build the value: this is
    what `run_enterprise_cycle` calls, so a test exercising a phase runner
    gets the context production gets, including a profile READ FROM THE TOOLS
    DIRECTORY rather than passed in. A test that needs a different profile
    has to set one, which is the production gesture.
    """
    return PhaseContext(
        cycle_id=cycle_id,
        # Resolved once here rather than at each callsite: the pre-collapse
        # code passed the raw argument to most phases and
        # `Path(...).resolve()` to the extended ones, so two phases could
        # disagree about which directory they were looking at. Production
        # always supplies an absolute path, so resolving is a no-op there;
        # what it buys is that the disagreement is no longer expressible.
        workspace_root=Path(workspace_root).resolve(),
        base_dir=base_dir,
        workspace=workspace if workspace is not None else workspace_paths(Path(workspace_root), None),
        plan_id=plan_id,
        shadow_only=shadow_only,
        defer_reflection=defer_reflection,
        snapshot_mode=snapshot_mode,
        profile=get_profile(base_dir=base_dir),
        mode=mode,
        cycle_started_at=cycle_started_at if cycle_started_at is not None else datetime.now(timezone.utc),
        started_monotonic=started_monotonic if started_monotonic is not None else time.monotonic(),
        results={},
        outcomes={},
    )


def run_enterprise_cycle(
    *,
    workspace_root: str | Path,
    cycle_id: str,
    workspace_base: str | Path | None = None,
    base_dir: str | Path | None = None,
    shadow_only: bool = False,
    discovery_only: bool = False,
    snapshot_mode: str = "committed",
    plan_id: str | None = None,
    defer_reflection: bool = False,
    mode: str = "standard",
) -> dict[str, Any]:
    """Run one cycle by walking ``CYCLE_PHASES``.

    This function owns the two boundaries the table cannot express —
    a discovery-only cycle returns before the pre_tool stage, and a
    failed pre_tool phase aborts before tools dispatch — and nothing
    else. Every other step is a row in the table.
    """
    # Plan ARIA-V3.3 §2b — ``defer_reflection`` opt-in for the autonomy
    # orchestrator. When True, the in-cycle ``run_reflection`` call
    # (line ~397 below) is skipped and ``state["reflection"]`` is
    # ``None``; the orchestrator invokes reflection itself AFTER its
    # planner+bridge+worker+auto_merge drainer phases complete so the
    # operator-visible daily report counts the full cycle (~25+ events)
    # rather than the pre-drainer snapshot (~4 events) that the
    # 2026-05-16 autonomous-loop audit surfaced as F-010-D2-POSTMORTEM.
    # Default ``False`` preserves the direct CLI contract (``aria-
    # kernel cycle run``) so non-orchestrator callers still receive a
    # reflection payload in the state dict.
    #
    # Plan ARIA-V2 §3.4 + CRITICAL-009 established that input validation
    # must run at function entry, BEFORE any side effect, so an operator
    # gets the right error class for a structurally-detectable mistake.
    # That principle is now satisfied structurally rather than by a
    # check: the phase list is not an input at all. There is no
    # `run_phases` tuple to be malformed, so there is nothing to validate
    # and nothing that can be validated too late — the tier-1 form of the
    # same guarantee. `_assert_pipeline_is_well_formed` checks the table
    # itself at import time, which is earlier still.
    started = time.monotonic()
    if mode not in CYCLE_MODES:
        raise GovernanceError(
            f"cycle_mode_unknown: {mode!r} (valid: {list(CYCLE_MODES)})"
        )
    # Plan 025 §C — UTC wall-clock of cycle start. Bounds the
    # change_committed window for validation_matrix phase so the
    # gate runs only against changes landed inside this cycle (not
    # historical changes from earlier cycles).
    cycle_started_at = datetime.now(timezone.utc)
    root = ensure_tools_binding(base_dir, workspace_root=workspace_root)
    if (root / "ARIA_STOP").exists():
        # Plan 024 §E — ARIA_STOP path used to return without
        # appending a terminal row to cycles.jsonl, leaving the cycle
        # "open forever" against integrity._verify_cycle_lifecycle.
        # We persist a typed `stopped` terminal row before returning
        # so cycle lifecycle integrity holds for stop-aborted cycles.
        append_declared_jsonl(root / "cycles.jsonl", _stopped_event(cycle_id), expected_surface="cycles")
        return {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "event": "stopped",
            "status": "stopped",
        }
    workspace = _ensure_enterprise_workspace(workspace_root, workspace_base, root)
    git_head_sha_at_cycle = _git_head_sha(Path(workspace_root))
    append_declared_jsonl(root / "cycles.jsonl", _started_cycle_row(cycle_id=cycle_id), expected_surface="cycles")
    # Burn-in cycles stay out of the learning hooks by mode, mirroring the
    # pre-collapse burn-in loop, which never ran them: an observe burn-in
    # proves the repo-observation lane alone, and the learning pass's
    # pressure-decay/prune writes are standard-lane bookkeeping.
    if mode == "burn_in":
        learning_pre = {"hooks": [], "skipped": "mode:burn_in"}
    else:
        learning_pre = run_learning_pre_cycle(workspace, cycle_id=cycle_id, tools_root=root)
    learning = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "pre_cycle": learning_pre,
        "post_evidence_closure": {},
        "hooks": list(learning_pre.get("hooks", [])),
    }
    emit_progress("cycle_started", cycle_id=cycle_id, shadow_only=shadow_only, discovery_only=discovery_only)

    # The context is built ONCE and handed to every phase.
    context = build_phase_context(
        cycle_id=cycle_id,
        workspace_root=workspace_root,
        base_dir=root,
        workspace=workspace,
        plan_id=plan_id,
        shadow_only=shadow_only,
        defer_reflection=defer_reflection,
        snapshot_mode=snapshot_mode,
        mode=mode,
        cycle_started_at=cycle_started_at,
        started_monotonic=started,
    )

    # PLAN Wave 1 §2.5 — refuse to run on a tree that cannot be shown to
    # descend from the last published state. The phase assessed; this decides.
    # It lives here rather than in the phase for the same reason the ARIA_STOP
    # refusal does: a cycle that stops must still append a terminal row, and
    # only this function owns the cycles.jsonl lifecycle.
    _run_phase_stage("preflight", context)
    continuity = context.result("state_continuity")
    if isinstance(continuity, dict) and continuity.get("blocks_action"):
        from .memory_gap import ContinuityVerdict, freeze_autonomous_writes, restore_and_replay

        diagnosed = ContinuityVerdict(
            status=str(continuity.get("status")),
            reference_kind=continuity.get("reference_kind"),
            reasons=tuple(continuity.get("reasons") or ()),
            lost_surfaces=tuple(continuity.get("lost_surfaces") or ()),
            current_manifest_root=continuity.get("current_manifest_root"),
            reference_manifest_root=continuity.get("reference_manifest_root"),
        )

        # ATTEMPT THE REPAIR BEFORE THE FREEZE. `reset_breaker` requires an
        # operator approval ref and truncates the failure ledger, so a freeze
        # followed by a successful recovery would leave a row only a human
        # could clear — the exact manual step recovery exists to remove. See
        # `restore_and_replay` for the full argument; it deviates from PLAN
        # §2.5's stated ordering deliberately and says so.
        recovery = restore_and_replay(
            Path(workspace_root), diagnosed, base_dir=root, cycle_id=cycle_id
        )
        # The verdict stays as the phase recorded it. A recovered gap is a gap
        # that HAPPENED, and rewriting `blocks_action` to False would make the
        # cycle row claim the tree was continuous all along — the run's own
        # history edited to match its outcome. What the recovery changes is
        # what this cycle DOES, not what it says it saw.
        continuity = {**continuity, "recovery": recovery.as_event()}
        context.results["state_continuity"] = continuity
        if recovery.resolved:
            emit_progress("state_gap_recovered", cycle_id=cycle_id, reason=recovery.reason)
        else:
            freeze_autonomous_writes(diagnosed, base_dir=root, cycle_id=cycle_id)
            emit_progress("cycle_aborted", cycle_id=cycle_id, reason="state_integrity_gap")
            event = _aborted_event(cycle_id, git_head_sha_at_cycle=git_head_sha_at_cycle)
            append_declared_jsonl(root / "cycles.jsonl", event, expected_surface="cycles")
            return {
                "schema_version": 2,
                "cycle_id": cycle_id,
                "git_head_sha_at_cycle": git_head_sha_at_cycle,
                "status": "aborted",
                "event": event,
                "learning": learning,
                "state_continuity": continuity,
            }

    _run_phase_stage("discovery", context)
    discovery = context.result("discovery")
    diff = context.result("cycle_diff")

    if discovery_only:
        emit_progress("cycle_completed", cycle_id=cycle_id, status="completed", discovery_only=True)
        event = _complete_event(root, cycle_id, 0, git_head_sha_at_cycle=git_head_sha_at_cycle)
        state = {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "git_head_sha_at_cycle": git_head_sha_at_cycle,
            "status": "completed",
            "event": event,
            "learning": learning,
            "discovery": discovery,
            "cycle_diff": diff,
            "phases": dict(context.outcomes),
        }
        _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
        return state

    # Plan 023 v3 §R-1 — the pre_tool stage runs BEFORE the tool loop so a
    # gate observes preconditions rather than consequences. That ordering
    # used to depend on the caller picking the `pre_tool_phases` keyword
    # instead of `run_phases`; it is now a property of the table, so a
    # pre-tool gate cannot be demoted to a post-tool observation by a
    # caller's choice of argument.
    _run_phase_stage("pre_tool", context)
    aborted_by = _first_blocking_pre_phase(context)
    if aborted_by is not None:
        # Plan 024 §E — pre-fix this path called _complete_event which
        # appended a row with event="completed" even though the cycle was
        # being aborted, AND the in-memory state.status was "aborted" —
        # persisted ledger and in-memory shape disagreed. Post-fix we
        # persist a typed `aborted` terminal row whose (event, status)
        # match the in-memory state. The tool loop hasn't run yet at this
        # point, so decision_count is structurally zero.
        event = _aborted_event(
            cycle_id,
            git_head_sha_at_cycle=git_head_sha_at_cycle,
            decision_count=0,
        )
        append_declared_jsonl(root / "cycles.jsonl", event, expected_surface="cycles")
        return {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "git_head_sha_at_cycle": git_head_sha_at_cycle,
            "status": "aborted",
            "event": {**event, "reason": f"cycle_aborted_by_pre_phase:{aborted_by}"},
            "phases": dict(context.outcomes),
            "aborted_by_phase": aborted_by,
        }

    _run_phase_stage("tools", context)
    tools_result = context.result("tools") or {}
    decisions = tools_result.get("decisions") or []
    run_summary = tools_result.get("run_summary") or []

    _run_phase_stage("post_tool", context)

    learning = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "pre_cycle": learning_pre,
        "post_evidence_closure": context.result("learning_post_evidence_closure"),
        "hooks": (
            list(learning_pre.get("hooks", []))
            + list((context.result("learning_post_evidence_closure") or {}).get("hooks", []))
        ),
    }
    artifact_integrity = context.result("artifact_integrity")
    non_ok_runs = _non_ok_runs(context)
    runtime_status = _runtime_status(context)
    post_tool_failure = _first_phase_failure(context)

    # Plan 025 §C — cycle status propagation. A phase whose payload
    # declares ``status == "fail"`` downgrades the cycle's terminal row
    # via _failed_event; otherwise the happy path. Pre-fix _complete_event
    # was called unconditionally, so a failed validation_matrix or
    # pr_lifecycle silently passed through as a "completed" cycle,
    # defeating the purpose of running the gate.
    phase_failures = [
        phase.name for phase in CYCLE_PHASES
        if isinstance(context.result(phase.name), dict)
        and context.result(phase.name).get("status") == "fail"
    ]
    failed_phases: list[dict[str, Any]] = [
        {"phase": name, "status": "failed"} for name in phase_failures
    ]
    if post_tool_failure is not None:
        failed_phases.append(post_tool_failure)
    # PLAN Wave 2 PR 1.2 — "no plan silently half-done", checked where the
    # cycle actually seals. The plan called for a `cycle_seal` PHASE; there is
    # none, and inventing one would put the check in a table row that runs
    # before the terminal decision it is supposed to describe. Here it observes
    # exactly the cycle the row about to be appended describes.
    #
    # OBSERVE-ONLY in this PR: a violation is recorded and does NOT downgrade
    # the cycle. Every mission opened by mission_ingest starts in DISCOVERED
    # with no next_action, so making this fail_cycle on day one would redden
    # the nightly for the expected state of brand-new missions rather than for
    # anything wrong. The promotion to a cycle-downgrading gate belongs with
    # the scheduler that gives missions their next_action.
    #
    # Fail-soft on its own error for the same reason the continuity gate is:
    # a closure check that CRASHED did not observe a clean cycle, but it must
    # not be able to brick the lane either.
    try:
        closure = assert_cycle_closure(base_dir=root)
    except Exception as exc:  # noqa: BLE001 - recorded, never fatal
        append_tools_governance(
            root,
            "mission_closure_check_failed",
            {"schema_version": 1, "cycle_id": cycle_id, "error": str(exc)},
        )
    else:
        if closure.get("violations"):
            emit_progress(
                "mission_closure", cycle_id=cycle_id,
                violations=len(closure["violations"]),
            )

    if phase_failures or runtime_status != "ok":
        event = _failed_event(
            cycle_id,
            decision_count=len(decisions),
            git_head_sha_at_cycle=git_head_sha_at_cycle,
        )
        append_declared_jsonl(root / "cycles.jsonl", event, expected_surface="cycles")
        update_tools_index(root)
        state_status: str = "failed"
    else:
        event = _complete_event(
            root, cycle_id, len(decisions),
            git_head_sha_at_cycle=git_head_sha_at_cycle,
        )
        update_tools_index(root)
        state_status = "completed"
    emit_progress("cycle_completed", cycle_id=cycle_id, status=state_status,
                  runtime_status=runtime_status, failed_phases=[f.get("phase") for f in failed_phases])
    # ORPHAN-HIGH-424 — read AFTER this cycle's terminal row is appended
    # (both branches above write one), so the snapshot counts only cycles
    # that were genuinely abandoned. Carried whole, not just as a count:
    # when `cycles.jsonl` cannot be read at all the count is 0 but
    # `valid` is False, and a consumer that sees only the number would
    # report "no incomplete cycles" for an unreadable ledger.
    cycle_lifecycle = _cycle_lifecycle_snapshot(root)
    state: dict[str, Any] = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "status": state_status,
        "runtime_status": runtime_status,
        "phase_failures": phase_failures,
        "failed_phases": failed_phases,
        "event": event,
        "learning": learning,
        "cycle_diff": diff,
        "cycle_metrics": context.result("metrics"),
        "artifact_integrity": artifact_integrity,
        "artifact_refs": [run["artifact_ref"] for run in run_summary if isinstance(run.get("artifact_ref"), dict)],
        "non_ok_tools": non_ok_runs,
        # ORPHAN-HIGH-424 — derived, not pinned. Pre-fix this was the
        # literal 0 that runtime_artifacts then summed across cycles, so a
        # cycle killed mid-run stayed invisible in every operator-facing
        # summary while `integrity verify` could already see it.
        "incomplete_lifecycle_count": int(cycle_lifecycle.get("incomplete_count") or 0),
        "cycle_lifecycle": cycle_lifecycle,
        "tool_decisions": decisions,
        "tool_governance_decisions": decisions,
        "tool_run_summary": run_summary,
        # The outcome ledger: ran / skipped / failed / degraded per phase,
        # with the reason. This is where a phase that did NOT run becomes
        # visible — the whole failure mode this collapse exists to remove
        # was a phase being absent with nothing to read about it.
        "phases": dict(context.outcomes),
    }
    # The remaining top-level keys are a PROJECTION of the phase results,
    # declared by `state_key` on each table row rather than assembled a
    # second time here. That is what keeps the state dict and the phase
    # results from being two stores that can disagree.
    for phase in CYCLE_PHASES:
        if phase.state_key is not None:
            state[phase.state_key] = context.result(phase.name)
    _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
    return state


# ---------------------------------------------------------------------
# Phase runners.
#
# One function per row of CYCLE_PHASES, each taking the context and
# returning that phase's payload. They contain no ordering, no guards and
# no error handling: ordering is the table's `stage` + position,
# permission is `precondition`, and failure is `on_error`. That split is
# what makes the pipeline readable as data — a runner that re-implemented
# any of the three would put the pipeline back into control flow where it
# cannot be inspected.
# ---------------------------------------------------------------------


def _phase_state_continuity(context: PhaseContext) -> dict[str, Any]:
    """Does the tree this cycle opened on descend from the last published state?

    PLAN Wave 1 §2.5. The reference has to come from OUTSIDE the tree, because
    a tree that lost its history also lost any record that it had one. Two
    exist and are tried in that order: the ``aria/state`` branch tip, which
    carries the full surface map, and the daily anchors committed into the
    repository, which carry the manifest root alone.

    The runner ASSESSES and returns; it does not decide. Stopping the cycle is
    the caller's boundary (a phase cannot append the terminal row that keeps
    cycle-lifecycle integrity), and the freeze is `freeze_autonomous_writes`.
    Three responsibilities, three places, one rule each.
    """
    from .memory_gap import (
        REFERENCE_STATE_BRANCH,
        assess_memory_continuity,
        continuity_probe_roots,
        resolve_continuity_reference,
        store_is_at_published_tip,
    )
    from .state_snapshot import build_snapshot

    # The probe must walk the roots the reference COVERS. Tools-only was right
    # while every reference was an anchor stub with no surface map; against a
    # published snapshot it reports sixteen healthy workspace and repo surfaces
    # as lost, which is `critical`, which blocks the cycle (PR 2.6c).
    current = build_snapshot(
        snapshot_id=f"continuity-{context.cycle_id}",
        cycle_id=context.cycle_id,
        lane=context.mode,
        roots=continuity_probe_roots(Path(context.workspace_root), Path(context.base_dir)),
    )

    # Resolution lives in memory_gap, not here: which authority is strongest,
    # and which failures are evidence rather than noise, are properties of the
    # continuity rule — and a rule spelled at its callsite is a rule the next
    # callsite spells differently. It deliberately does NOT swallow a damaged
    # store; that raise reaches this phase's `record_and_continue`, which is
    # the "failed to look" outcome rather than a quietly weaker answer.
    reference, reference_kind = resolve_continuity_reference(Path(context.workspace_root))

    # Descent is decided by the transport, not by chain linkage: a probe is
    # built fresh and so has no `prev_manifest_root`, which makes the linkage
    # test answer "broken" for a healthy tree every time. Only asked when the
    # reference IS the branch — an anchor reference has no tip to compare to,
    # and keeps the linkage test it was designed for.
    descent = (
        store_is_at_published_tip(Path(context.workspace_root))
        if reference_kind == REFERENCE_STATE_BRANCH
        else None
    )

    verdict = assess_memory_continuity(
        current=current,
        reference=reference,
        reference_kind=reference_kind,
        descent=descent,
    )
    return {
        "schema_version": 1,
        "status": verdict.status,
        "reference_kind": verdict.reference_kind,
        "reasons": list(verdict.reasons),
        "notes": list(verdict.notes),
        "lost_surfaces": list(verdict.lost_surfaces),
        "current_manifest_root": verdict.current_manifest_root,
        "reference_manifest_root": verdict.reference_manifest_root,
        "blocks_action": verdict.blocks_action,
    }


def _phase_mission_reconcile(context: PhaseContext) -> dict[str, Any]:
    """What did the world do to this mission's PRs while nobody was looking?

    PLAN Wave 2 PR 1.3. In PREFLIGHT, before discovery, because every later
    phase reasons about mission state and reading it before reconciliation is
    reading what ARIA last wrote rather than what is true. A merge that landed
    between two nightlies must be known before the scheduler counts WIP slots
    or `mission_ingest` folds new candidates in beside it.

    The adapter comes from the SAME profile-derived factory the merge lane
    uses, and that is what makes the observe-first discipline structural:
    `observe`/`standard`/`frozen` get a `RecordingGitHubAdapter` that returns
    `None` to every lifecycle question, so on those lanes the phase can only
    observe. No soak flag exists because none is needed — and none can be
    forgotten in the "on" position.
    """
    return reconcile_missions(
        cycle_id=context.cycle_id,
        observer=select_github_adapter(
            profile=context.profile,
            base_dir=context.base_dir,
            cwd=context.workspace_root,
        ),
        base_dir=context.base_dir,
    )


def _phase_discovery(context: PhaseContext) -> dict[str, Any]:
    emit_progress("discovery", cycle_id=context.cycle_id, phase="started")
    discovery = run_discovery(
        workspace_root=context.workspace_root,
        cycle_id=context.cycle_id,
        base_dir=context.base_dir,
        snapshot_mode=context.snapshot_mode,
    )
    emit_progress(
        "discovery", cycle_id=context.cycle_id, phase="completed",
        fated_file_count=(discovery.get("completion_proof") or {}).get("fated_file_count"),
    )
    return discovery


def _phase_cycle_diff(context: PhaseContext) -> dict[str, Any]:
    return run_cycle_diff(cycle_id=context.cycle_id, base_dir=context.base_dir)


def _phase_twin_refresh(context: PhaseContext) -> dict[str, Any]:
    """Keep the repository map current, incrementally, once per cycle.

    Twin-lite shipped as a CLI, so the map was only ever as fresh as the last
    time a human ran `twin refresh`. A map ARIA consults about a tree it no
    longer has is worse than no map: it answers confidently about the past.

    The refresh re-parses only what changed since ``indexed_sha`` and falls
    back to a full build when there is no prior map or its anchor commit is
    unknown to this clone — and it SAYS WHICH in ``refresh.mode``, so "the
    cycle did no full scan" is an observation rather than an assumption.
    """
    from .twin import refresh_twin_map

    return refresh_twin_map(workspace_root=context.workspace_root, base_dir=context.base_dir)


def _phase_tools(context: PhaseContext) -> dict[str, Any]:
    """Run every dispatchable tool and summarise the runs it produced.

    THE STATUS FILTER WAS TWO BRANCHES THAT SELECTED THE SAME SET.
    Pre-collapse this read `if shadow_only and status not in ("SHADOW",
    "ACTIVE", "CALIBRATE"): continue` followed by `if not shadow_only and
    status not in ("ACTIVE", "SHADOW", "CALIBRATE"): continue` — the same
    three values in a different order, so the branch on `shadow_only`
    decided nothing. It read as though a shadow run dispatched a narrower
    set of tools, and it never did. Collapsed to the one check that was
    actually happening; the no-write behaviour of a shadow cycle lives in
    the phase preconditions and in `enforce_profile_for_write`, not here.
    """
    emit_progress("tools", cycle_id=context.cycle_id, phase="started")
    decisions: list[Any] = []
    pressure_summary: dict[str, Any] = {}
    for tool in list_tools(base_dir=context.base_dir):
        if tool.get("status") not in ("ACTIVE", "SHADOW", "CALIBRATE"):
            continue
        payload = dict(tool.get("default_input") or {})
        payload.update({"cycle_id": context.cycle_id, "pressure_summary": pressure_summary})
        decisions.append(
            run_tool(
                str(tool["tool_id"]),
                payload,
                context.cycle_id,
                workspace_root=context.workspace_root,
                base_dir=context.base_dir,
            ),
        )
    # v2 runtime contract — prefer the per-cycle run index to avoid an
    # O(N) scan over a growing runs.jsonl. The helper falls back to the
    # strict runs reader for legacy ledgers.
    run_summary: list[dict[str, Any]] = []
    for run in read_runs_for_cycle(base_dir=context.base_dir, cycle_uid=context.cycle_id):
        runner = run.get("runner") if isinstance(run.get("runner"), dict) else {}
        artifact_ref = run.get("artifact_ref") if isinstance(run.get("artifact_ref"), dict) else None
        run_summary.append(
            {
                "tool_id": run.get("tool_id"),
                "run_id": run.get("run_id"),
                "status": run.get("status"),
                "artifact_status": run.get("artifact_status", "legacy_inline_or_sample_only"),
                "artifact_ref": artifact_ref,
                "artifact_hash": run.get("artifact_hash"),
                "raw_findings_count": int(runner.get("raw_findings_count") or 0),
                "raw_observations_count": int(runner.get("raw_observations_count") or 0),
                "emitted_findings_count": len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0,
                "emitted_observations_count": len(run.get("emitted_observations", [])) if isinstance(run.get("emitted_observations"), list) else 0,
            },
        )
    return {"decisions": decisions, "run_summary": run_summary}


def _phase_triage(context: PhaseContext) -> dict[str, Any]:
    from .triage import triage_policy_apply

    return triage_policy_apply(
        context.workspace,
        cycle_id=context.cycle_id,
        tools_root=context.base_dir,
    )


def _phase_memory(context: PhaseContext) -> dict[str, Any]:
    # Plan 026R §E.7 — pass workspace_root so update_memory's FATES hash
    # recompute check fires. Pre-§E.7 legacy callers omitted it and the
    # integrity check silently skipped.
    emit_progress("memory", cycle_id=context.cycle_id, phase="started")
    return update_memory(
        cycle_id=context.cycle_id,
        base_dir=context.base_dir,
        workspace_root=context.workspace_root,
    )


def _phase_belief_decay(context: PhaseContext) -> dict[str, Any]:
    # Plan 028 §D4 — age-based belief decay runs BEFORE pressure, so a
    # belief about unchanged code that has aged past its TTL becomes
    # needs_revalidation and run_pressure surfaces it this same cycle.
    return decay_stale_beliefs_by_age(cycle_id=context.cycle_id, base_dir=context.base_dir)


def _phase_pressure(context: PhaseContext) -> dict[str, Any]:
    # Plan S4 (ORPHAN-MEDIUM-298) — operator drift-class targeting:
    # genesis-policy weights bias pressure scores per class. The loader is
    # fail-soft (defaults on any error), and _doc keys are not classes, so
    # passing the block through unfiltered is safe.
    emit_progress("pressure", cycle_id=context.cycle_id, phase="started")
    drift_weights = load_policy(context.workspace_root).get("drift_class_weights")
    return run_pressure(
        cycle_id=context.cycle_id,
        base_dir=context.base_dir,
        drift_class_weights=drift_weights,
    )


def _phase_mission_ingest(context: PhaseContext) -> dict[str, Any]:
    """Turn this cycle's task candidates into persistent missions.

    PLAN Wave 2 PR 1.2 — the FIRST production caller of
    `task.generate_task_candidates`, which had existed with none. Runs after
    `pressure` because pressure rows are one of the four candidate sources and
    the generator reads this cycle's pressure artifact.

    Adoption is idempotent by mission identity, so a candidate re-discovered
    on a later night folds into the mission it already opened. That is the
    whole point of PR 1.1's identity rule, and this is what consumes it.
    """
    return adopt_task_candidates(
        cycle_id=context.cycle_id,
        repo_hash=repo_hash(context.workspace_root),
        base_dir=context.base_dir,
    )


def _phase_agent_claim_reap(context: PhaseContext) -> dict[str, Any]:
    """Give the queue back the requests a dead executor is still holding.

    `reap_stale_claims` has existed since the lease work and was reachable only
    from the operator CLI (`aria-kernel agent reap-stale`) — no cycle phase, no
    workflow. Its sibling `dispatch_lease_reap` below runs every cycle, but it
    reaps a DIFFERENT ledger (`dispatch/claims.jsonl`, worker assignments). The
    agent-invocation ledger had no automatic reaper at all.

    What that costs is not a delay, it is a permanent leak. `PENDING` is
    reachable from `CLAIMED` only through an explicit released/requeued event;
    once the 30-minute lease expires the state derives `STALE`, which
    `next_pending_request` skips and `claim_request` refuses. Both exits are
    closed and the request is dead. Measured on production state 2026-08-09:
    ten of twelve requests sitting in exactly that shape, so every executor run
    found nothing to do while nine baseline-carrying requests waited behind
    them.

    Requeue is still bounded — `DEFAULT_MAX_REQUEUES` caps it and the state
    then derives HUMAN_REQUIRED, so a genuinely poisonous request escalates to
    a human instead of cycling forever.
    """
    return reap_stale_claims(base_dir=context.base_dir)


def _phase_dispatch_lease_reap(context: PhaseContext) -> dict[str, Any]:
    """Give back the WIP slot a dead worker is still holding.

    PLAN Wave 2 PR 1.4 (ORPHAN-HIGH-487). The admission gate in
    `promote_converged_plan_to_dispatch` refuses a second promotion while any
    assignment is in flight, and `_derive_assignment_state` has always
    documented a reaper for expired leases that did not exist. Without one,
    the gate turns a single abandoned worker into a permanent freeze: the
    assignment stays `picked_up` forever and no plan is ever promoted again.

    A lease that expired is a POSITIVE observation — a deadline the claim
    itself recorded, now past. A claim carrying no deadline is not judged.
    """
    return reap_expired_assignment_claims(base_dir=context.base_dir)


def _phase_consensus_escalation(context: PhaseContext) -> dict[str, Any]:
    # Plan 023 §B — drain consensus disagreements / low-confidence verdicts
    # into HUMAN_REQUIRED so a split judge vote reaches an operator instead
    # of being silently held. Idempotent, so re-running a cycle never
    # double-escalates.
    return sweep_consensus_uncertainties_for_human_required(base_dir=context.base_dir)


def _phase_lease_lifecycle_escalation(context: PhaseContext) -> dict[str, Any]:
    # P1-03 — claims-ledger escalations reach the operator-facing surface.
    # `derive_request_state` can say HUMAN_REQUIRED while no
    # `human-required/<id>.json` file exists, and the reconciling sweep had
    # CLI-only callers — so an escalation was visible in one view and
    # invisible in the one operators and the daily report read. Running it
    # every cycle is what makes the two views agree.
    return sweep_lease_lifecycle_for_human_required(base_dir=context.base_dir)


def _phase_human_required_adjudication(context: PhaseContext) -> dict[str, Any]:
    # ORPHAN-HIGH-450 — act on the escalations the two sweeps above just
    # created. ORPHAN-HIGH-426 was closed with a 498-line adjudication
    # panel that had zero non-test importers, so escalations were still
    # being raised every cycle and cleared by nobody: the finding's own
    # defect, reproduced by its fix. This is the caller.
    return sweep_human_required_adjudications(base_dir=context.base_dir)


def _phase_judgment_pipeline(context: PhaseContext) -> dict[str, Any]:
    """Sample findings, fan judges out, compute consensus — every cycle.

    The whole judgment supply chain — `generate_judgment_sample`,
    `dispatch_judges_for_sample`, `generate_ai_consensus` — was driven only by
    `heartbeat_tick`, and `heartbeat.py` had ZERO importers repo-wide. No
    samples were ever minted, no judges fanned out, no consensus computed;
    `judged_judges` read zero for months and three separate defects were
    blamed before the dead driver was found. Same class as the claim reaper
    and the registry compiler: the mechanism existed, nothing invoked it.

    Extracted here (the heartbeat file is deleted with this change, not kept
    as a parallel copy), with one repair the extraction surfaced: heartbeat
    passed ``target_sha=None`` to the fan-out, which would have graded every
    judge's real evidence `baseline_unavailable` — the exact defect that
    rejected the autonomy planner's first surviving run. Judges now anchor to
    the workspace head like every other minted request.

    Per-tool failures are recorded and do not stop the loop —
    `batch_containment`: one bad item costs that item, never the batch.
    """
    from .convergence_drainer import _resolve_workspace_head_sha
    from .feedback_store import generate_ai_consensus, generate_judgment_sample
    from .judge_fanout import dispatch_judges_for_sample

    target_sha = _resolve_workspace_head_sha(context.workspace_root)
    sampled = 0
    fanned_out = 0
    consensus_rows = 0
    blocked: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=context.base_dir):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id:
            continue
        try:
            sample = generate_judgment_sample(
                tool_id=tool_id,
                sample_size=5,
                strategy="stratified_by_uncertainty",
                cycle_id=context.cycle_id,
                base_dir=context.base_dir,
            )
            sampled += len(sample.get("items") or [])
            fanout = dispatch_judges_for_sample(
                sample=sample, base_dir=context.base_dir, target_sha=target_sha,
            )
            fanned_out += len(fanout.get("minted") or [])
        except GovernanceError as exc:
            blocked.append({"tool_id": tool_id, "step": "sample_or_fanout", "reason": str(exc)[:200]})
        try:
            consensus = generate_ai_consensus(
                tool_id=tool_id,
                cycle_id=context.cycle_id,
                base_dir=context.base_dir,
                workspace_root=context.workspace_root,
            )
            consensus_rows += len(consensus.get("consensus") or []) if isinstance(consensus, dict) else 0
        except GovernanceError as exc:
            blocked.append({"tool_id": tool_id, "step": "consensus", "reason": str(exc)[:200]})
    return {
        "status": "completed",
        "sampled_findings": sampled,
        "judge_requests_minted": fanned_out,
        "consensus_rows": consensus_rows,
        "target_sha": target_sha,
        "blocked": blocked,
    }


def _phase_judge_replay(context: PhaseContext) -> dict[str, Any]:
    """Re-examine every judge against the gold corpus, and score the recall.

    `replay_judges_on_goldset` and `compute_replay_recall` had zero callers —
    the regression memory existed and nothing ever sat the judges back down
    in front of it. A judge change that forgot an old lesson was silent.
    """
    from .convergence_drainer import _resolve_workspace_head_sha
    from .judge_replay import compute_replay_recall, replay_judges_on_goldset

    target_sha = _resolve_workspace_head_sha(context.workspace_root)
    replayed: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=context.base_dir):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id:
            continue
        try:
            result = replay_judges_on_goldset(
                tool_id=tool_id, base_dir=context.base_dir, target_sha=target_sha,
            )
            replayed.append({"tool_id": tool_id, "status": result.get("status"), "replayed_items": result.get("replayed_items")})
        except GovernanceError as exc:
            replayed.append({"tool_id": tool_id, "status": "blocked", "reason": str(exc)[:200]})
    recall = compute_replay_recall(base_dir=context.base_dir)
    return {"status": "completed", "tools": replayed, "replay_recall": recall}


def _phase_fixture_refresh(context: PhaseContext) -> dict[str, Any]:
    """Keep every tool's fixture verdict current — the third heartbeat organ.

    Fixture health feeds SHADOW→ACTIVE promotion (`adapter_active_readiness`);
    with the driver dead, no fixture suite has run automatically since the
    heartbeat was superseded, so promotion evidence could only rot.
    """
    from .fixture_runner import refresh_fixture_suite

    refreshed: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=context.base_dir):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or not tool.get("fixture_set"):
            continue
        try:
            result = refresh_fixture_suite(
                tool_id,
                workspace_root=context.workspace_root,
                cycle_id=context.cycle_id,
                base_dir=context.base_dir,
            )
            refreshed.append({"tool_id": tool_id, "status": result.get("status", "ok")})
        except GovernanceError as exc:
            refreshed.append({"tool_id": tool_id, "status": "blocked", "reason": str(exc)[:200]})
    return {"status": "completed", "tools": refreshed}


def _phase_judge_calibration(context: PhaseContext) -> dict[str, Any]:
    # Plan 024 §A — score each judge against accumulated ground truth so
    # the cheap-tier judgment is measured, not assumed. Read-only join over
    # the feedback ledger (no LLM).
    return compute_judge_calibration(cycle_id=context.cycle_id, base_dir=context.base_dir)


def _phase_goldset_proposal(context: PhaseContext) -> dict[str, Any]:
    # F4.2 of the intelligence program — the producer `propose_goldset` never
    # had. Counting labelled feedback is machine work, so the cycle mints the
    # proposal (and the distance-to-ready that comes with it); promotion stays
    # an operator act behind `goldset promote --curator`.
    return propose_goldsets_for_labelled_tools(
        cycle_id=context.cycle_id, base_dir=context.base_dir,
    )


def _phase_calibration_recommendation(context: PhaseContext) -> dict[str, Any]:
    # The write side of ARIA's own scoring had no feeder. `record_weight_override`
    # turns an approved recommendation into behaviour, and the only thing that
    # could produce a recommendation was `heartbeat_tick` — a superseded driver
    # that calls `run_cycle` itself and therefore has no production caller.
    # `list_calibration_recommendations` had none at all. Three dead links in
    # one chain: nothing computed a recommendation, nothing read one, so there
    # was never anything for an operator to approve.
    #
    # Deliberately NOT wired by resurrecting heartbeat_tick: it would invoke the
    # cycle from inside the cycle. The phase pipeline is the driver now, so the
    # producer becomes a phase, next to judge_calibration and goldset_proposal
    # which read the same feedback ledger.
    #
    # It stops at `recommendation_only` on purpose. Applying a weight change is
    # an operator act (`pressure weight-override`), because a system that
    # silently reweights its own scoring can rationalise anything it later
    # measures — the same line goldset promotion draws.
    result = recommend_calibration(cycle_id=context.cycle_id, base_dir=context.base_dir)
    # FAZ 4c — rank_pressure_sources' first caller. The effectiveness ledger
    # (converged/minted per pressure source) is exactly the context an
    # operator needs to judge a weight recommendation, and the ranking
    # function had zero callers since V9.0-F. Advisory data: its absence or
    # failure must not cost the recommendation.
    try:
        from .knowledge_graph import rank_pressure_sources

        result["source_effectiveness"] = rank_pressure_sources(
            workspace_root=context.workspace_root
        )
    except (OSError, ValueError, KeyError, TypeError):
        result["source_effectiveness"] = []
    return result


def _phase_proactive_priority(context: PhaseContext) -> dict[str, Any]:
    # Plan 027 §D3 — proactive Impact x Opportunity ranking, computed every
    # cycle regardless of reactive pressure, so ARIA always has a "where to
    # invest next" list even when nothing is on fire.
    return compute_proactive_priorities(cycle_id=context.cycle_id, base_dir=context.base_dir)


def _phase_reflection(context: PhaseContext) -> dict[str, Any]:
    emit_progress("reflection", cycle_id=context.cycle_id, phase="started")
    return run_reflection(
        cycle_id=context.cycle_id,
        base_dir=context.base_dir,
        repo_root=context.workspace_root,
        calibration_result=context.result("judge_calibration") or None,
        recommendation_result=context.result("calibration_recommendation") or None,
        proactive_result=context.result("proactive_priority") or None,
    )


def _phase_service_examination(context: PhaseContext) -> dict[str, Any]:
    """Per-service examination plan (ORPHAN-MEDIUM-258/259).

    Surfaces the changed services + their downstream ripple in DEPENDENCY
    (topological) order, and scopes this cycle's pressures to the
    service(s) their evidence touches. Cached by graph fingerprint (no
    re-scan when the project graph is unchanged).
    """
    diff = context.result("cycle_diff")
    changed_paths = (diff.get("changed_paths") if isinstance(diff, dict) else None) or []
    pressure = context.result("pressure")
    cycle_pressures = pressure.get("pressures") if isinstance(pressure, dict) else None
    if not changed_paths and not cycle_pressures:
        return {}
    emit_progress(
        "service_examination", cycle_id=context.cycle_id, phase="started",
        changed_paths=len(changed_paths), pressures=len(cycle_pressures or []),
    )
    return cycle_service_examination(
        workspace_root=context.workspace_root,
        base_dir=context.base_dir,
        changed_files=changed_paths,
        pressures=cycle_pressures,
    )


# The four core services, in the risk order the service-audit program set
# (charter M-5.1). These are seeded even on a quiet night; every other
# service earns its mission from examination evidence (changed files or
# scoped pressures), so the mission ledger grows with reality instead of
# opening 17 parallel fronts on day one.
SERVICE_HARDENING_CORE: tuple[str, ...] = (
    "auth-service", "billing-service", "farm-service", "sensor-service",
)


def _phase_service_mission_seed(context: PhaseContext) -> dict[str, Any]:
    """Turn the examination's targeting into durable service-hardening missions.

    `cycle_service_examination` computes which services changed, their
    downstream ripple, the owning agents and the per-service pressures — and
    had ZERO consumers. `SERVICE_MAP.json` inventories every platform service
    each cycle — and nobody read it. This phase is the first consumer of the
    first and, through the core list, the intent of the second: the charter's
    per-service hardening program (§5) finally has a producer.

    Idempotent by mission identity: re-seeding a service folds into the
    mission it already opened.
    """
    from .mission import open_mission

    exam = context.result("service_examination")
    exam = exam if isinstance(exam, dict) else {}
    # The producer (`impact_graph.cycle_service_examination`) emits
    # per_service_pressures as a LIST of {service, layer, pressures} groups
    # in topological order — not a dict keyed by project. The first live
    # cycle over this phase failed with "'list' object has no attribute
    # 'get'" because the seeder assumed the dict shape its own test had
    # invented (ORPHAN-HIGH-622). Normalize at the boundary; accept both
    # shapes so a future producer change cannot re-break the seeder.
    raw_per_service = exam.get("per_service_pressures") or []
    if isinstance(raw_per_service, dict):
        per_service = raw_per_service
    else:
        per_service = {
            str(group.get("service")): (group.get("pressures") or [])
            for group in raw_per_service
            if isinstance(group, dict) and group.get("service")
        }
    order = exam.get("examination_order") or []
    evidence_backed = [
        entry["project"] for entry in order
        if entry.get("changed_files") or per_service.get(entry.get("project"))
    ]
    targets: list[str] = list(dict.fromkeys(list(SERVICE_HARDENING_CORE) + evidence_backed))
    rh = repo_hash(context.workspace_root)
    seeded: list[dict[str, Any]] = []
    for rank, project in enumerate(targets):
        pressures_here = per_service.get(project) or []
        result = open_mission(
            source_kind="service_hardening",
            source_id=project,
            repo_hash=rh,
            title=(
                f"Harden {project}: secure/performant/sustainable/testable/"
                f"documented/correct (charter D1-D6)"
            ),
            capability="service_hardening",
            priority=rank,
            target_project=project,
            base_dir=context.base_dir,
        )
        seeded.append({
            "project": project,
            "mission_id": result.get("mission_id"),
            "idempotent": bool(result.get("idempotent")),
            "scoped_pressures": len(pressures_here),
        })
    return {
        "status": "completed",
        "seeded": seeded,
        "core": list(SERVICE_HARDENING_CORE),
        "evidence_backed": evidence_backed,
    }


def _phase_mission_selection(context: PhaseContext) -> dict[str, Any]:
    """Run the scheduler in the cycle, and hand the winner to the queue.

    `select_next_mission` had exactly one caller — the operator CLI — so even
    a fully seeded mission ledger would never move without a human. The
    selected mission becomes a bounded-queue item (`mission:<id>` marker) the
    autonomy drain resolves into an agent request; the non-selections stay
    recorded by the scheduler itself, because "why not" is the half of the
    decision an operator actually debugs.
    """
    from .mission_scheduler import select_next_mission
    from .next_cycle_queue import append_pending

    decision = select_next_mission(base_dir=context.base_dir)
    selected = decision.selected if decision.selected else None
    queued = None
    if selected:
        mission_id = str(selected.get("mission_id") or "")
        queued_row = append_pending(
            context.base_dir,
            source_cycle_id=context.cycle_id,
            pressure_id=f"mission:{mission_id}",
            recommended_action=str(selected.get("next_action") or selected.get("title") or "advance the mission"),
            candidate_tools=[],
        )
        queued = (queued_row or {}).get("queue_item_id")
    return {
        "status": "completed",
        "outcome": decision.outcome,
        "selected_mission": (selected or {}).get("mission_id"),
        "selected_project": (selected or {}).get("target_project"),
        "queue_item_id": queued,
        "considered": decision.considered,
    }


def _phase_learning_post_evidence_closure(context: PhaseContext) -> dict[str, Any]:
    return run_learning_post_evidence_closure(
        context.workspace, cycle_id=context.cycle_id, tools_root=context.base_dir,
    )


def _learning_post_error_payload(context: PhaseContext, exc: Exception) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "cycle_id": context.cycle_id,
        "status": "failed",
        "error": str(exc),
        "hooks": [],
    }


def _phase_artifact_integrity(context: PhaseContext) -> dict[str, Any]:
    return verify_artifacts(base_dir=context.base_dir)


def _phase_metrics(context: PhaseContext) -> dict[str, Any]:
    tools_result = context.result("tools") or {}
    run_summary = tools_result.get("run_summary") or []
    decisions = tools_result.get("decisions") or []
    return record_cycle_metrics(
        cycle_id=context.cycle_id,
        phase_durations_ms={"cycle": int((time.monotonic() - context.started_monotonic) * 1000)},
        artifact_count=len(run_summary) + 4,
        status="ok" if _runtime_status(context) == "ok" else "failed",
        cost_units=sum(
            float((decision.get("envelope") or {}).get("cost_units") or 0)
            for decision in decisions if isinstance(decision, dict)
        ),
        base_dir=context.base_dir,
    )


def _phase_observability_dashboard(context: PhaseContext) -> dict[str, Any]:
    return generate_observability_dashboard(cycle_id=context.cycle_id, base_dir=context.base_dir)


def _observability_error_payload(context: PhaseContext, exc: Exception) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "cycle_id": context.cycle_id,
        "status": "failed",
        "error": str(exc),
    }


def _phase_tool_manifest_sync(context: PhaseContext) -> dict[str, Any]:
    """Register the repo's adapter manifests into the runtime tool registry.

    `tools/aria-adapters/*.tool.json` is the declared single source for
    adapter registrations, `registry_compiler` exists to compile them, and the
    CLI carries a `tool register` verb — and none of it was called against the
    LIVE registry, which held zero tools. That empty registry is what made
    `_filter_candidate_tools` strip the schema-drift pressure's only tool
    every cycle, which is what ARIA's first accepted agent response traced
    (AIR-aria-autonomy-planner-5636a540ccaa, RC-1). Same defect class as the
    claim reaper above: the mechanism existed, nothing invoked it.

    Registration goes through `register_tool` per manifest, NOT the compiler's
    direct write, because the compiler bypasses the status transition matrix —
    a quarantined tool must stay quarantined until the audited unquarantine
    path clears it. A manifest that the matrix refuses is reported, not
    escalated: the refusal IS the governance working.
    """
    manifest_dir = Path(context.workspace_root) / "tools" / "aria-adapters"
    # The manifest's `status` is the tool's BIRTH status; after registration
    # the live lifecycle (transition_tool, quarantine, calibration) owns it.
    # Passing the manifest status verbatim on RE-registration made the
    # transition matrix read every lifecycle advance as an attempted
    # demotion (live CALIBRATE vs manifest SHADOW → refused), so runner
    # contract updates silently never reached the runtime: the registry
    # served tenant-scoping's stale timeout_ms=180000 two cycles after the
    # manifest raised it, and the node heap contract never landed at all
    # (ORPHAN-HIGH-625). Re-registration therefore carries the LIVE status,
    # which routes through the matrix's same-status lane — "manifest hash
    # drift → allow; parser/runner update" — the lane built for exactly this.
    live_status_by_id = {
        str(tool.get("tool_id")): str(tool.get("status"))
        for tool in list_tools(base_dir=context.base_dir)
    }
    synced: list[str] = []
    refused: list[dict[str, str]] = []
    for manifest_path in sorted(manifest_dir.glob("*.tool.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            live_status = live_status_by_id.get(str(manifest.get("tool_id")))
            if live_status is not None:
                manifest = {**manifest, "status": live_status}
            register_tool(manifest, base_dir=context.base_dir)
            synced.append(str(manifest.get("tool_id") or manifest_path.stem))
        except (GovernanceError, ValueError, OSError) as exc:
            refused.append({
                "manifest": manifest_path.name,
                "reason": str(exc)[:200],
            })
    return {
        "status": "synced",
        "synced_tool_ids": synced,
        "refused": refused,
        "manifest_dir": str(manifest_dir),
    }


def _phase_architecture_baseline(context: PhaseContext) -> dict[str, Any]:
    from .architecture_spine_gate import take_baseline

    return take_baseline(
        plan_id=_required_plan_id(context),
        cycle_id=context.cycle_id,
        workspace_root=context.workspace_root,
        base_dir=context.base_dir,
    )


def _phase_architecture_postcheck(context: PhaseContext) -> dict[str, Any]:
    from .architecture_spine_gate import take_postcheck

    return take_postcheck(
        plan_id=_required_plan_id(context),
        cycle_id=context.cycle_id,
        workspace_root=context.workspace_root,
        base_dir=context.base_dir,
    )


def _required_plan_id(context: PhaseContext) -> str:
    """Narrow ``plan_id`` for the two phases whose precondition demands it.

    The precondition already guarantees this, but only at runtime — the
    type is still ``str | None`` at the callsite, and the alternative
    spellings are a cast or a non-null assertion, both of which this
    repository bans for the same reason: they assert rather than check. A
    GovernanceError here is unreachable while `PLAN_ID_PRESENT` gates both
    phases, and it is the correct failure if that ever stops being true.
    """
    if context.plan_id is None:
        raise GovernanceError(
            "cycle_phase_requires_plan_id: a phase gated on PLAN_ID_PRESENT ran "
            "without one, which means the table and the driver have diverged"
        )
    return context.plan_id


def _run_validation_matrix_phase(context: PhaseContext) -> dict[str, Any]:
    """Plan 025 §C — invoke enforce_validation_matrix per change_id
    committed inside the cycle window.

    Returns per-id aggregate dict with ``status`` ∈
    {``no_op``, ``ok``, ``fail``}. ``fail`` propagates to the cycle's
    terminal status via the _complete_event-vs-_failed_event branch
    in run_enterprise_cycle.

    GovernanceError from enforce_validation_matrix is caught per
    change_id so a single failure does not abort the entire phase
    (operator sees every change's outcome, not just the first
    failure).

    THE ``cycle_started_at is None`` DEGRADATION IS GONE. It existed for
    "legacy callers" that omitted the kwarg, and returned a ``no_op``
    that is indistinguishable in the ledger from "there was nothing to
    validate". There are no such callers now: the window bound comes from
    the context every cycle builds, so the phase cannot be invoked
    without one and cannot report a silent no-op that means "I was called
    wrong".
    """
    from .change_ledger import (
        get_change_chain,
        list_committed_change_ids_in_window,
    )
    from .validation_matrix_gate import enforce_validation_matrix

    workspace_root = context.workspace_root
    base_dir = context.base_dir
    change_ids = list_committed_change_ids_in_window(
        since=context.cycle_started_at, base_dir=base_dir,
    )
    per_change: list[dict[str, Any]] = []
    ok = 0
    for cid in change_ids:
        try:
            chain = get_change_chain(change_id=cid, base_dir=base_dir)
        except GovernanceError as exc:
            per_change.append({
                "change_id": cid, "passed": False,
                "error": f"chain_lookup_failed: {exc}",
            })
            continue
        validated = chain.get("validated") or {}
        refs = list(validated.get("validation_run_refs") or [])
        try:
            res = enforce_validation_matrix(
                change_id=cid,
                base_dir=base_dir,
                repo_root=workspace_root,
                candidate_refs=refs,
                # Plan 031 Gate A — every change committed inside the cycle
                # window is an ARIA-authored autonomous fix, so it must leave
                # a regression anchor (test/fixture) in its diff.
                require_regression_anchor=True,
            )
            per_change.append({
                "change_id": cid,
                "passed": bool(res.get("passed")),
                "gate_result": res,
            })
            if res.get("passed"):
                ok += 1
        except GovernanceError as exc:
            per_change.append({
                "change_id": cid, "passed": False,
                "error": str(exc),
            })
    total = len(change_ids)
    if total == 0:
        status = "no_op"
    elif ok == total:
        status = "ok"
    else:
        status = "fail"
    return {
        "status": status, "total": total,
        "ok": ok, "fail": total - ok,
        "change_ids": per_change,
    }


def _run_pr_lifecycle_phase(context: PhaseContext) -> dict[str, Any]:
    """Plan 025 §C — invoke pr_manager.open_pr_for_action(dry_run=True)
    per approved-for-apply proposal.

    Returns per-proposal aggregate dict with ``status`` ∈
    {``no_op``, ``ok``, ``fail``}. ``fail`` propagates to the cycle's
    terminal status.

    dry_run=True is the cycle-side default — a live PR open is an
    operator-explicit action (out of cycle scope). The pr_manager
    primitive enforces its own preconditions (apply action exists,
    validation_gate_ref present, branch resolvable, gh CLI
    available); GovernanceError raised by any precondition is
    caught per proposal so the phase iterates the full eligible
    list and aggregates outcomes.

    RC-1 — THIS IS THE PHASE THAT WAS NEVER ON THE LANE. Until the
    collapse it ran only when a caller passed `run_phases` /
    `pre_tool_phases`, and no production caller did, so
    `ORPHAN-CRITICAL-428`'s pre-PR-open perimeter had exactly one live
    entrance: an operator typing `aria-kernel pr open`. The table now
    puts it on every cycle whose profile permits `pr_open`. Two things
    had to be true first, and both are: the breaker edge is gone
    (ORPHAN-CRITICAL-503, so a dry-run stage report cannot self-halt the
    nightly), and the precondition reads the same permission table
    `open_pr_for_action` enforces (so the phase does not run under a
    profile that will refuse it and call that a cycle failure).
    """
    # RC-2 — `record_failure` and `PERIMETER_REFUSED_PREFIX` were imported here
    # for the breaker edge this phase no longer has, and are removed with it. An
    # import left behind after its call is deleted is not cosmetic: keeping the
    # symbol importable while the call is gone is exactly what made
    # ORPHAN-HIGH-499's mutation invisible to a `hasattr` test, and it would let
    # a future reader conclude the edge is still here.
    from .pr_manager import open_pr_for_action
    from .proposal import list_proposals

    workspace_root = context.workspace_root
    base_dir = context.base_dir
    eligible = [
        p for p in list_proposals(base_dir=base_dir)
        if p.get("status") == "approved_for_apply"
    ]
    per_proposal: list[dict[str, Any]] = []
    ok = 0
    for prop in eligible:
        pid = prop.get("proposal_id")
        try:
            action_result = open_pr_for_action(
                proposal_id=pid,
                workspace_root=workspace_root,
                base_dir=base_dir,
                dry_run=True,
            )
            per_proposal.append({
                "proposal_id": pid,
                "passed": True,
                "action_result": action_result,
            })
            ok += 1
        except GovernanceError as exc:
            per_proposal.append({
                "proposal_id": pid,
                "passed": False,
                "error": str(exc),
            })
            # RC-2 — THE BREAKER EDGE WAS REMOVED FROM HERE, deliberately, and
            # the removal is the fix rather than a walk-back of
            # ORPHAN-CRITICAL-420 S5.
            #
            # What used to be here: on a refusal whose message started with
            # PERIMETER_REFUSED_PREFIX, `record_failure(kind=
            # "validator_rejection")` fired. It was placed here because this is
            # an observation point — cycle.py already aggregates per proposal —
            # and that reasoning was sound about WHERE. It was wrong about WHAT.
            #
            # This phase calls `open_pr_for_action(dry_run=True)`, and
            # `open_pr_for_action` runs the 10-check GATE_PRE_PR_OPEN perimeter
            # BEFORE its dry_run branch so a preview cannot skip the gate. But a
            # dry run opens nothing: no changed_files, no base_sha, no diff. So
            # checks needing those refuse on data that CANNOT exist at this
            # stage, and every such refusal was counted as a rejected
            # implementation. Three approved_for_apply proposals in one cycle
            # would trip a breaker that now gates `standard` — the nightly
            # halting itself on its own observations. It has never fired only
            # because `_run_extended_phases` is unreachable
            # (ORPHAN-CRITICAL-498); RC-1 puts this phase on the live lane, so
            # the edge had to go before that lands, not after.
            #
            # An observation cannot trip a safety breaker. That is now
            # structural, not intended: this phase evaluates the perimeter
            # through `observe_perimeter`, which returns a PerimeterObservation
            # with no `passed`, no `failures` and no `raise_if_blocked` — there
            # is no attribute here a breaker producer could read as a refusal,
            # and `tests/invariants/v3/test_perimeter_observe_has_no_breaker_edge.py`
            # asserts no static call path from observe-mode to record_failure.
            #
            # The refusal is still fully REPORTED — the row above carries
            # `passed: False` and the verbatim error — it is simply not COUNTED.
            # Nothing is re-evaluated here: the perimeter already ran inside
            # `open_pr_for_action`, and rebuilding a HardFailContext at this
            # callsite to observe it a second time would duplicate the context
            # assembly pr_manager owns. Observation belongs where the context
            # already exists, which is why `observe_perimeter` is wired into the
            # dry_run branch there rather than here.
            #
            # The breaker keeps its live producer: planner_dispatch_hook.py
            # records `subprocess_timeout` from a single except arm, discriminated
            # structurally rather than by message prefix. ORPHAN-CRITICAL-485
            # stays closed; what changes is that a dry-run stage report no longer
            # masquerades as a rejected implementation.
    total = len(eligible)
    if total == 0:
        status = "no_op"
    elif ok == total:
        status = "ok"
    else:
        status = "fail"
    return {
        "status": status, "total": total,
        "ok": ok, "fail": total - ok,
        "proposals": per_proposal,
    }


# =====================================================================
# CYCLE_PHASES — the pipeline. This tuple IS the cycle.
#
# Ordered exactly as the phases execute. Reading it top to bottom is
# reading what a cycle does, which was not true of anything in this file
# before: `DEFAULT_CYCLE_PHASES` named five of these and got one of the
# five names wrong.
#
# Adding a phase means adding a row. There is no second place to also
# register it, no kwarg to also thread through, and no caller to also
# update — which is the property that made the four extended phases
# possible to write and never notice were dead.
# =====================================================================
CYCLE_PHASES: tuple[CyclePhase, ...] = (
    # --- preflight: is this tree the one the last published state left? ---
    # In `burn_in` too, and that is the point rather than an oversight: the
    # observe lane's output is the acceptance evidence the autonomy ladder
    # counts, and evidence gathered on a tree that forgot its history is
    # exactly the evidence that must not count.
    #
    # `record_and_continue`, not `propagate`. A gate that CRASHED did not
    # observe a gap; it failed to look, which is the `unknown` class and must
    # not brick the lane. The crash is still a `failed` outcome row, so "the
    # gate is broken" and "the gate passed" remain different observations.
    CyclePhase(
        "state_continuity", "preflight", _phase_state_continuity,
        on_error="record_and_continue", state_key="state_continuity",
        modes=frozenset({"standard", "burn_in"}),
    ),

    # Reconciliation runs on the standard lane only. A burn-in cycle's whole
    # claim is that no action surface was touched, and moving a mission is an
    # action — the mode column is what keeps that claim structural rather
    # than remembered.
    CyclePhase(
        "mission_reconcile", "preflight", _phase_mission_reconcile,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="mission_reconcile",
    ),

    # --- discovery: what changed, and is that all we were asked for? ---
    CyclePhase(
        "discovery", "discovery", _phase_discovery,
        on_error="propagate", state_key="discovery",
        modes=frozenset({"standard", "burn_in"}),
    ),
    CyclePhase(
        "cycle_diff", "discovery", _phase_cycle_diff,
        on_error="propagate",
        modes=frozenset({"standard", "burn_in"}),
    ),
    # The repository map, kept current by the cycle that reads it.
    #
    # `record_and_continue`, not `propagate`: a refresh that CRASHED leaves a
    # stale map, which is a degraded read for the one consumer that wants it
    # — not a reason to end a cycle whose real work succeeded. The failure is
    # still an outcome row, and `twin_status` reports `fresh: false`, so
    # "the map is old" and "the map is current" stay distinguishable.
    #
    # In `burn_in` too. The map is a declared OBSERVATION surface and touches
    # no claim, tool or PR surface, so it does not weaken the observe lane's
    # no-action claim; and the observe lane's output is the acceptance
    # evidence the ladder counts, which must not be judged against a map
    # frozen at some past commit.
    CyclePhase(
        "twin_refresh", "discovery", _phase_twin_refresh,
        on_error="record_and_continue", state_key="twin_refresh",
        modes=frozenset({"standard", "burn_in"}),
    ),

    # --- pre_tool: gates that must observe preconditions, not results ---
    # Before anything reads the tool registry: the repo's adapter manifests
    # are its declared source, and a registry nobody fills strips every
    # pressure's candidate tools (the defect ARIA's first accepted response
    # traced). Standard lane only — registration is an action.
    CyclePhase(
        "tool_manifest_sync", "pre_tool", _phase_tool_manifest_sync,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="tool_manifest_sync",
    ),
    CyclePhase(
        "architecture_baseline", "pre_tool", _phase_architecture_baseline,
        precondition=PLAN_ID_PRESENT, on_error="record_and_continue",
    ),

    # --- tools: the adapters run ---
    CyclePhase(
        "tools", "tools", _phase_tools,
        on_error="propagate",
    ),

    # --- post_tool: everything that reads what the tools produced ---
    CyclePhase(
        "memory", "post_tool", _phase_memory, state_key="memory",
        modes=frozenset({"standard", "burn_in"}),
    ),
    CyclePhase(
        "belief_decay", "post_tool", _phase_belief_decay,
        precondition=WRITES_PERMITTED, state_key="belief_decay",
    ),
    CyclePhase(
        "pressure", "post_tool", _phase_pressure, state_key="pressure",
        modes=frozenset({"standard", "burn_in"}),
    ),
    # Burn-in only: the observe lane's triage step. Not part of the
    # standard cycle (the nightly's triage happens through reflection's
    # next-cycle planning), and the mode column is what keeps it out.
    CyclePhase(
        "triage", "post_tool", _phase_triage, state_key="triage",
        modes=frozenset({"burn_in"}),
    ),
    # BEFORE mission ingest, not after reflection where it used to sit
    # unread: the examination's whole output — which services, in what
    # order, which agent owns them, which pressures land in them — is the
    # targeting a mission needs, and for months it was computed and then
    # dropped on the floor (zero consumers). The seed phase right after it
    # is its first consumer.
    CyclePhase(
        "service_examination", "post_tool", _phase_service_examination,
        on_error="swallow", state_key="service_examination",
    ),
    CyclePhase(
        "service_mission_seed", "post_tool", _phase_service_mission_seed,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="service_mission_seed",
    ),
    CyclePhase(
        "mission_ingest", "post_tool", _phase_mission_ingest,
        precondition=WRITES_PERMITTED, state_key="mission_ingest",
    ),
    # The scheduler had exactly one caller: the operator CLI. Even seeded
    # missions would never be picked up automatically. Selection now runs in
    # the cycle, and the selected mission becomes a queue item the autonomy
    # drain can mint an agent request from.
    CyclePhase(
        "mission_selection", "post_tool", _phase_mission_selection,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="mission_selection",
    ),
    # Bookkeeping over a ledger, so it sits with the other post-tool
    # bookkeeping — and `record_and_continue`, because a reaper that CRASHED
    # released nothing but must not be able to fail a cycle whose real work
    # succeeded. Standard lane only: releasing an assignment is an action.
    # Beside dispatch_lease_reap because they are the same idea on two
    # ledgers: hand back what a dead holder is still holding.
    CyclePhase(
        "agent_claim_reap", "post_tool", _phase_agent_claim_reap,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="agent_claim_reap",
    ),
    CyclePhase(
        "dispatch_lease_reap", "post_tool", _phase_dispatch_lease_reap,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="dispatch_lease_reap",
    ),
    CyclePhase(
        "consensus_escalation", "post_tool", _phase_consensus_escalation,
        precondition=WRITES_PERMITTED, state_key="consensus_escalation",
    ),
    CyclePhase(
        "lease_lifecycle_escalation", "post_tool", _phase_lease_lifecycle_escalation,
        precondition=WRITES_PERMITTED, state_key="lease_escalation",
    ),
    CyclePhase(
        "human_required_adjudication", "post_tool", _phase_human_required_adjudication,
        precondition=WRITES_PERMITTED, state_key="human_required_adjudication",
    ),
    # The judgment supply chain, in dependency order and BEFORE calibration:
    # fixtures stay fresh, findings get sampled, judges fan out, consensus is
    # computed. All three were heartbeat organs, and heartbeat had zero
    # importers — judged_judges read zero for months because nothing upstream
    # of judge_calibration ever produced a verdict for it to score.
    CyclePhase(
        "fixture_refresh", "post_tool", _phase_fixture_refresh,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="fixture_refresh",
    ),
    CyclePhase(
        "judgment_pipeline", "post_tool", _phase_judgment_pipeline,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="judgment_pipeline",
    ),
    CyclePhase(
        "judge_calibration", "post_tool", _phase_judge_calibration,
        precondition=WRITES_PERMITTED, state_key="judge_calibration",
    ),
    # After calibration, before the goldset proposal reads the same ledgers:
    # sit every judge back down in front of the gold corpus and score the
    # recall, so a judge change that forgot an old lesson is loud.
    CyclePhase(
        "judge_replay", "post_tool", _phase_judge_replay,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="judge_replay",
    ),
    # Directly after judge_calibration: both read the same feedback ledger,
    # and the gold corpus this mints is what judge_replay scores judges
    # against. `record_and_continue` — a proposal that CRASHED recorded no
    # ground truth, but it must not fail a cycle whose real work succeeded.
    CyclePhase(
        "goldset_proposal", "post_tool", _phase_goldset_proposal,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="goldset_proposal",
    ),
    # After the corpus phases, because it reads the same feedback ledger they
    # do. `record_and_continue`: a recommendation that crashed produced no
    # advice, which must not fail a cycle whose real work succeeded.
    CyclePhase(
        "calibration_recommendation", "post_tool", _phase_calibration_recommendation,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="calibration_recommendation",
    ),
    CyclePhase(
        "proactive_priority", "post_tool", _phase_proactive_priority,
        precondition=WRITES_PERMITTED, state_key="proactive_priorities",
    ),
    CyclePhase(
        "reflection", "post_tool", _phase_reflection,
        precondition=REFLECTION_NOT_DEFERRED, state_key="reflection",
        # Plan ARIA-V3.3 §2b — the autonomy orchestrator defers reflection
        # and runs it after its drainers, and it reads `state["reflection"]
        # is None` to know that happened. So this phase's absence is None,
        # not {}: an empty dict would read as "reflection ran and found
        # nothing".
        absent=lambda: None,
    ),
    CyclePhase(
        "learning_post_evidence_closure", "post_tool", _phase_learning_post_evidence_closure,
        on_error="record_and_continue", error_payload=_learning_post_error_payload,
    ),
    CyclePhase(
        "artifact_integrity", "post_tool", _phase_artifact_integrity,
        on_error="propagate", state_key="artifact_integrity",
        # In burn_in too: `_runtime_status` reads this phase's verdict, and
        # a per-cycle integrity read is a strengthening the observe lane
        # was missing — verification is read-only, so the no-action
        # property holds.
        modes=frozenset({"standard", "burn_in"}),
    ),
    CyclePhase(
        "metrics", "post_tool", _phase_metrics,
        on_error="record_and_continue", state_key="cycle_metrics",
        error_payload=_observability_error_payload,
    ),
    CyclePhase(
        "observability_dashboard", "post_tool", _phase_observability_dashboard,
        on_error="record_and_continue", state_key="observability_dashboard",
        error_payload=_observability_error_payload,
    ),
    CyclePhase(
        "architecture_postcheck", "post_tool", _phase_architecture_postcheck,
        precondition=PLAN_ID_PRESENT, on_error="record_and_continue",
        state_key="architecture_postcheck",
    ),
    CyclePhase(
        "validation_matrix", "post_tool", _run_validation_matrix_phase,
        precondition=WRITES_PERMITTED, on_error="record_and_continue",
        state_key="validation_matrix",
    ),
    CyclePhase(
        "pr_lifecycle", "post_tool", _run_pr_lifecycle_phase,
        precondition=PROFILE_PERMITS_PR_OPEN, on_error="record_and_continue",
        state_key="pr_lifecycle",
    ),
)


def _assert_pipeline_is_well_formed() -> None:
    """Import-time checks on the table itself.

    Earlier than any test and earlier than any cycle: a malformed table
    makes `import aria_kernel.cycle` fail, so it cannot reach a runtime
    where the damage is a half-run pipeline. This is the check that
    replaced validating `run_phases` at function entry — the input is
    gone, so what remains to validate is the declaration.
    """
    seen: set[str] = set()
    for phase in CYCLE_PHASES:
        if phase.name in seen:
            raise ValueError(f"duplicate cycle phase name: {phase.name!r}")
        seen.add(phase.name)
        if phase.stage not in CYCLE_STAGES:
            raise ValueError(f"phase {phase.name!r} declares unknown stage {phase.stage!r}")
        if not any(phase.precondition is known for known in CYCLE_PRECONDITIONS):
            raise ValueError(
                f"phase {phase.name!r} declares a precondition that is not in "
                f"CYCLE_PRECONDITIONS; the vocabulary is closed on purpose",
            )
        if not phase.modes or not phase.modes.issubset(set(CYCLE_MODES)):
            raise ValueError(
                f"phase {phase.name!r} declares modes {sorted(phase.modes)!r} "
                f"outside the closed vocabulary {list(CYCLE_MODES)}",
            )
    # Stage order is the table's order. A row placed out of stage order
    # would run in the position the table implies but be grouped under a
    # stage that runs elsewhere — the ambiguity the two kwargs created.
    stages = [phase.stage for phase in CYCLE_PHASES]
    if stages != sorted(stages, key=CYCLE_STAGES.index):
        raise ValueError(
            f"CYCLE_PHASES rows are not grouped in stage order {CYCLE_STAGES}; got {stages}",
        )
    keys = [phase.state_key for phase in CYCLE_PHASES if phase.state_key is not None]
    if len(keys) != len(set(keys)):
        raise ValueError(
            f"two phases project onto the same state key: "
            f"{sorted({k for k in keys if keys.count(k) > 1})}",
        )


_assert_pipeline_is_well_formed()


# ---------------------------------------------------------------------
# The driver.
# ---------------------------------------------------------------------


def _run_phase_stage(stage: PhaseStage, context: PhaseContext) -> None:
    """Run every phase of one stage, in table order.

    Writes into ``context.results`` (payloads) and ``context.outcomes``
    (ran / skipped / failed / degraded, with a reason). Nothing is
    returned: a second copy of what the context already holds is exactly
    the duplication this collapse removes.
    """
    for phase in CYCLE_PHASES:
        if phase.stage != stage:
            continue
        if context.mode not in phase.modes:
            _record_skip(context, phase, f"mode_not_included:{context.mode}")
            continue
        upstream = _first_phase_failure(context)
        if phase.on_error == "halt_sequence" and upstream is not None:
            _record_skip(context, phase, f"upstream_failure:{upstream.get('phase')}")
            continue
        if not phase.precondition.satisfied_by(context):
            _record_skip(context, phase, f"precondition_unmet:{phase.precondition.name}")
            continue
        if phase.on_error == "propagate":
            # No handler by design: if discovery or the tool loop cannot
            # run there is no cycle to report on, and swallowing that
            # would produce a "completed" cycle that did nothing.
            context.results[phase.name] = phase.runner(context)
            context.outcomes[phase.name] = {"outcome": "ran"}
            continue
        try:
            context.results[phase.name] = phase.runner(context)
        except Exception as exc:
            context.results[phase.name] = (
                phase.error_payload(context, exc)
                if phase.error_payload is not None
                else phase.absent()
            )
            context.outcomes[phase.name] = {
                "outcome": "degraded" if phase.on_error == "swallow" else "failed",
                "error": str(exc),
            }
        else:
            context.outcomes[phase.name] = {"outcome": "ran"}


def _record_skip(context: PhaseContext, phase: CyclePhase, reason: str) -> None:
    """A phase that did not run still leaves a row.

    This is the whole point. Pre-collapse, a phase that was not requested
    produced nothing at all — no key, no reason, no trace — so "this gate
    is not wired" and "this gate passed" were the same observation from
    outside. They are now different rows.
    """
    context.results[phase.name] = phase.absent()
    context.outcomes[phase.name] = {"outcome": "skipped", "reason": reason}


def _first_phase_failure(context: PhaseContext) -> dict[str, Any] | None:
    """The first phase that failed, in execution order, or None.

    Derived from the outcome ledger rather than tracked in a parallel
    variable, so "did something fail?" has one answer. ``degraded`` is
    deliberately not a failure: that is what the `swallow` policy means.
    """
    for name, outcome in context.outcomes.items():
        if outcome.get("outcome") == "failed":
            return {"phase": name, "status": "failed", "error": outcome.get("error")}
    return None


def _first_blocking_pre_phase(context: PhaseContext) -> str | None:
    """Plan 023 v3 §R-1 — the pre_tool phase, if any, that aborts the cycle.

    Two ways a pre-tool phase blocks: it raised (an outcome of
    ``failed``), or it returned a payload declaring itself failed,
    blocked or a regression. The second is how the architecture spine
    gate reports a regression — it returns rather than raises — and
    missing it would let a detected regression proceed to tool dispatch.
    """
    for phase in CYCLE_PHASES:
        if phase.stage != "pre_tool":
            continue
        if context.outcomes.get(phase.name, {}).get("outcome") == "failed":
            return phase.name
        payload = context.result(phase.name)
        if not isinstance(payload, dict):
            continue
        if (payload.get("status") or payload.get("decision")) in ("failed", "blocked", "regression"):
            return phase.name
    return None


def _non_ok_runs(context: PhaseContext) -> list[dict[str, Any]]:
    run_summary = (context.result("tools") or {}).get("run_summary") or []
    return [
        run for run in run_summary
        if run.get("status") != "ok"
        or run.get("artifact_status") in {"missing", "hash_mismatch", "write_failed"}
    ]


def _runtime_status(context: PhaseContext) -> str:
    """The cycle's runtime verdict, derived from the phases that ran.

    One definition, two readers — the metrics phase records it and the
    state assembly reports it. Pre-collapse those were two expressions of
    the same rule evaluated at different points in one function, which is
    how the metrics row could disagree with the cycle it described.
    """
    if _first_phase_failure(context) is not None:
        return "failed"
    integrity = context.result("artifact_integrity") or {}
    if _non_ok_runs(context) or not integrity.get("valid"):
        return "integrity_failed"
    return "ok"


def _cycle_lifecycle_snapshot(root: Path) -> dict[str, Any]:
    """ORPHAN-HIGH-424 — started-without-terminal snapshot for the summary.

    Imported lazily because ``integrity`` pulls in the runtime-artifact
    verifier, and a module-level import here would make the cycle module
    depend on the whole verification surface just to count rows.

    A read failure is reported as ``valid: False`` rather than raised: the
    cycle has already completed and written its terminal row by this
    point, so failing the cycle over a summary read would discard real
    work. The falsity is what consumers gate on.
    """
    from .integrity import cycle_lifecycle_status

    try:
        snapshot = cycle_lifecycle_status(root)
    except (OSError, GovernanceError) as exc:
        return {
            "valid": False,
            "incomplete_count": 0,
            "incomplete_cycles": [],
            "lifecycle_read_error": str(exc),
        }
    return snapshot


def _complete_event(
    root: Path,
    cycle_id: str,
    decision_count: int,
    *,
    git_head_sha_at_cycle: str | None = None,
) -> dict[str, Any]:
    """Plan 024 §E — completed terminal-row writer.

    Pre-fix this builder emitted a dict literal with no `status` field;
    post-fix the row is constructed via the typed `_completed_event`
    factory. The discriminated-union shape (`event="completed"` ↔
    `status="completed"`) is now structurally pinned by the factory.
    """
    row = _completed_event(
        cycle_id,
        decision_count,
        git_head_sha_at_cycle=git_head_sha_at_cycle,
    )
    append_declared_jsonl(root / "cycles.jsonl", row, expected_surface="cycles")
    return row


def _ensure_enterprise_workspace(workspace_root: str | Path, workspace_base: str | Path | None, tools_root: Path) -> WorkspacePaths:
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    try:
        ensure_workspace(paths)
        return paths
    except OSError as exc:
        if workspace_base is not None or exc.errno not in {errno.EROFS, errno.EACCES, errno.EPERM}:
            raise
    fallback = workspace_paths(Path(workspace_root), tools_root / "workspaces")
    ensure_workspace(fallback)
    return fallback


def _workspace_cycle_state(paths: WorkspacePaths, state: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "cycle_id": state.get("cycle_id"),
        "git_head_sha_at_cycle": state.get("git_head_sha_at_cycle"),
        "status": state.get("status"),
        "repo_root": str(paths.repo_root),
        "workspace_root": str(paths.workspace_root),
        "learning": state.get("learning"),
        "tools_event": state.get("event"),
    }


def _write_workspace_cycle_artifact(paths: WorkspacePaths, state: dict[str, Any]) -> None:
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    (paths.cycle_dir / f"{state['cycle_id']}.json").write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _git_head_sha(repo_root: Path) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root.resolve(),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None
