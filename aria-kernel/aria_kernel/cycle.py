from __future__ import annotations

import errno
import json
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .feedback import derive_pressure
from .ledger import verify_index_hashes, write_index
from .learning import run_learning_pass, run_learning_post_evidence_closure, run_learning_pre_cycle
from .workspace import WorkspacePaths, ensure_workspace, workspace_paths
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
from .human_required import sweep_consensus_uncertainties_for_human_required
from .judge_calibration import compute_judge_calibration
from .proactive_priority import compute_proactive_priorities
from .tool_registry import GovernanceError, ensure_tools_binding, list_tools, utc_now, update_tools_index
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


# Plan 022 §M-1 — opt-in cycle phase chain. The base set keeps Plan 016
# behaviour intact; operators can opt into extended phases that link
# the architecture spine gate, validation matrix, and PR lifecycle into
# the same cycle invocation. NOTE: 'pr_lifecycle' currently emits a
# placeholder governance event (no real PR action) — fully wiring it
# requires a proposal_id which the cycle entry point doesn't carry.
DEFAULT_CYCLE_PHASES: tuple[str, ...] = (
    "discover", "tools", "memory", "pressure", "reflection",
)
SUPPORTED_CYCLE_PHASES: tuple[str, ...] = DEFAULT_CYCLE_PHASES + (
    "architecture_baseline",
    "architecture_postcheck",
    "validation_matrix",
    "pr_lifecycle",
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
    run_phases: tuple[str, ...] | None = None,
    pre_tool_phases: tuple[str, ...] | None = None,
    plan_id: str | None = None,
    defer_reflection: bool = False,
) -> dict[str, Any]:
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
    # Plan 023 v3 §R-1 — pre_tool_phases kwarg runs extended phases
    # BEFORE the tool loop. Pre-Plan-023 all extended phases ran
    # AFTER tools, so architecture_baseline / validation_matrix_pre /
    # pr_lifecycle_pre observed consequences instead of preconditions
    # and could not gate tool dispatch. Post-fix: pre_tool_phases
    # fires first; failure aborts the cycle with cycle_aborted_by_
    # pre_phase. The legacy run_phases kwarg continues to run AFTER
    # tools (post-tool observation).
    # Plan ARIA-V2 §3.4 + CRITICAL-009 fix — input validation runs at
    # function entry BEFORE any side effect (discovery, memory write,
    # ledger append, FATES integrity recompute). Pre-fix the unknown-
    # phase check at line 391 fired AFTER ``update_memory`` had already
    # raised ``memory_fates_content_hash_mismatch`` against the (mutating)
    # governance.jsonl, so operators received the wrong error class for
    # a structurally-detectable input mistake. Validating preconditions
    # at entry is the Tier-1 architectural shape (impossible to ship a
    # cycle that mutates ledgers under a malformed run_phases tuple).
    if run_phases is not None:
        _unknown_run = [p for p in tuple(run_phases) if p not in SUPPORTED_CYCLE_PHASES]
        if _unknown_run:
            raise ValueError(
                f"unknown cycle phase(s): {_unknown_run}; "
                f"supported phases: {SUPPORTED_CYCLE_PHASES}"
            )
    if pre_tool_phases is not None:
        _unknown_pre = [p for p in tuple(pre_tool_phases) if p not in SUPPORTED_CYCLE_PHASES]
        if _unknown_pre:
            raise ValueError(
                f"unknown pre_tool_phases: {_unknown_pre}; "
                f"supported phases: {SUPPORTED_CYCLE_PHASES}"
            )
    started = time.monotonic()
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
    learning_pre = run_learning_pre_cycle(workspace, cycle_id=cycle_id, tools_root=root)
    learning = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "pre_cycle": learning_pre,
        "post_evidence_closure": {},
        "hooks": list(learning_pre.get("hooks", [])),
    }
    emit_progress("cycle_started", cycle_id=cycle_id, shadow_only=shadow_only, discovery_only=discovery_only)
    emit_progress("discovery", cycle_id=cycle_id, phase="started")
    discovery = run_discovery(workspace_root=workspace_root, cycle_id=cycle_id, base_dir=root, snapshot_mode=snapshot_mode)
    emit_progress("discovery", cycle_id=cycle_id, phase="completed",
                  fated_file_count=(discovery.get("completion_proof") or {}).get("fated_file_count"))
    diff = run_cycle_diff(cycle_id=cycle_id, base_dir=root)
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
        }
        _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
        return state

    # Plan 023 v3 §R-1 — pre_tool_phases run BEFORE the tool loop so
    # architecture_baseline / validation_matrix_pre / pr_lifecycle_pre
    # gate tool dispatch (observe preconditions, not consequences).
    # Failure short-circuits the cycle with cycle_aborted_by_pre_phase.
    pre_phase_results: dict[str, Any] = {}
    if pre_tool_phases is not None:
        active_pre = tuple(pre_tool_phases)
        unknown_pre = [p for p in active_pre if p not in SUPPORTED_CYCLE_PHASES]
        if unknown_pre:
            raise ValueError(
                f"unknown pre_tool_phases: {unknown_pre}; "
                f"supported phases: {SUPPORTED_CYCLE_PHASES}"
            )
        pre_phase_results = _run_extended_phases(
            phases=active_pre,
            workspace_root=Path(workspace_root).resolve(),
            cycle_id=cycle_id,
            base_dir=root,
            plan_id=plan_id,
        )
        # Plan 023 v3 §R-1 — pre-tool phase failure aborts cycle.
        # _run_extended_phases returns dict with phase results; if any
        # phase result is dict-shaped with status=='failed' or
        # 'blocked', short-circuit before tools run.
        for phase_name, phase_result in pre_phase_results.items():
            if not isinstance(phase_result, dict):
                continue
            phase_status = phase_result.get("status") or phase_result.get("decision")
            if phase_status in ("failed", "blocked", "regression"):
                # Plan 024 §E — pre-fix this path called _complete_event
                # which appended a row with event="completed" even
                # though the cycle was being aborted, AND the in-memory
                # state.status was "aborted" — persisted ledger and
                # in-memory shape disagreed. Post-fix we persist a
                # typed `aborted` terminal row whose (event, status)
                # match the in-memory state. The tool loop hasn't run
                # yet at this point, so decision_count is structurally
                # zero (no decisions have been emitted).
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
                    "event": {**event, "reason": f"cycle_aborted_by_pre_phase:{phase_name}"},
                    "pre_phase_results": pre_phase_results,
                    "aborted_by_phase": phase_name,
                }

    decisions = []
    run_summary = []
    pressure_summary: dict[str, Any] = {}
    emit_progress("tools", cycle_id=cycle_id, phase="started")
    for tool in list_tools(base_dir=root):
        if shadow_only and tool.get("status") not in ("SHADOW", "ACTIVE", "CALIBRATE"):
            continue
        if not shadow_only and tool.get("status") not in ("ACTIVE", "SHADOW", "CALIBRATE"):
            continue
        payload = dict(tool.get("default_input") or {})
        payload.update({"cycle_id": cycle_id, "pressure_summary": pressure_summary})
        decision = run_tool(
            str(tool["tool_id"]),
            payload,
            cycle_id,
            workspace_root=workspace_root,
            base_dir=root,
        )
        decisions.append(decision)
    # v2 runtime contract — prefer the per-cycle run index to avoid
    # O(N) scans over a growing runs.jsonl. The helper falls back to the
    # strict runs reader for legacy ledgers.
    for run in read_runs_for_cycle(base_dir=root, cycle_uid=cycle_id):
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
    # Plan 026R §E.7 — pass workspace_root so update_memory's FATES
    # hash recompute check fires. Pre-§E.7 legacy callers omitted
    # workspace_root and the integrity check silently skipped.
    # Runtime hardening: post-tool phase failures must still close the
    # cycle ledger and retain tool artifact evidence in the returned state.
    memory: dict[str, Any] = {}
    pressure: dict[str, Any] = {}
    reflection = None if defer_reflection else {}
    consensus_escalation: dict[str, Any] = {}
    judge_calibration: dict[str, Any] = {}
    proactive_priorities: dict[str, Any] = {}
    belief_decay: dict[str, Any] = {}
    post_tool_failure = None
    emit_progress("memory", cycle_id=cycle_id, phase="started")
    try:
        memory = update_memory(
            cycle_id=cycle_id, base_dir=root, workspace_root=workspace_root,
        )
    except Exception as exc:
        post_tool_failure = {"phase": "memory", "status": "failed", "error": str(exc)}
    # Plan 028 §D4 — age-based belief decay BEFORE pressure, so a belief about
    # unchanged code that has aged past its TTL becomes needs_revalidation and
    # run_pressure surfaces it this same cycle. Skipped under no-write runs.
    if post_tool_failure is None and not shadow_only and not discovery_only:
        try:
            belief_decay = decay_stale_beliefs_by_age(cycle_id=cycle_id, base_dir=root)
        except Exception as exc:
            post_tool_failure = {"phase": "belief_decay", "status": "failed", "error": str(exc)}
    if post_tool_failure is None:
        emit_progress("pressure", cycle_id=cycle_id, phase="started")
        try:
            # Plan S4 (ORPHAN-MEDIUM-298) — operator drift-class targeting:
            # genesis-policy weights bias pressure scores per class. The
            # loader is fail-soft (defaults on any error), and _doc keys are
            # not classes, so passing the block through unfiltered is safe.
            drift_weights = load_policy(workspace_root).get("drift_class_weights")
            pressure = run_pressure(
                cycle_id=cycle_id, base_dir=root,
                drift_class_weights=drift_weights,
            )
        except Exception as exc:
            post_tool_failure = {"phase": "pressure", "status": "failed", "error": str(exc)}
    # Plan 023 §B — drain consensus disagreements / low-confidence verdicts into
    # HUMAN_REQUIRED so a split judge vote reaches an operator instead of being
    # silently held. Skipped under shadow/discovery runs (no-write profiles);
    # idempotent so re-running a cycle never double-escalates.
    if post_tool_failure is None and not shadow_only and not discovery_only:
        try:
            consensus_escalation = sweep_consensus_uncertainties_for_human_required(base_dir=root)
        except Exception as exc:
            post_tool_failure = {"phase": "consensus_escalation", "status": "failed", "error": str(exc)}
    # Plan 024 §A — score each judge against accumulated ground truth so the
    # cheap-tier judgment is measured, not assumed. Read-only join over the
    # feedback ledger (no LLM); skipped under shadow/discovery no-write runs.
    if post_tool_failure is None and not shadow_only and not discovery_only:
        try:
            judge_calibration = compute_judge_calibration(cycle_id=cycle_id, base_dir=root)
        except Exception as exc:
            post_tool_failure = {"phase": "judge_calibration", "status": "failed", "error": str(exc)}
    # Plan 027 §D3 — proactive Impact x Opportunity ranking, computed every cycle
    # regardless of reactive pressure, so ARIA always has a "where to invest next"
    # list even when nothing is on fire. Read-only; skipped under no-write runs.
    if post_tool_failure is None and not shadow_only and not discovery_only:
        try:
            proactive_priorities = compute_proactive_priorities(cycle_id=cycle_id, base_dir=root)
        except Exception as exc:
            post_tool_failure = {"phase": "proactive_priority", "status": "failed", "error": str(exc)}
    if post_tool_failure is None and not defer_reflection:
        emit_progress("reflection", cycle_id=cycle_id, phase="started")
        try:
            reflection = run_reflection(
                cycle_id=cycle_id, base_dir=root, repo_root=workspace_root,
                calibration_result=judge_calibration or None,
                proactive_result=proactive_priorities or None,
            )
        except Exception as exc:
            post_tool_failure = {"phase": "reflection", "status": "failed", "error": str(exc)}
    # Per-service examination plan (ORPHAN-MEDIUM-258/259): surface the changed
    # services + their downstream ripple in DEPENDENCY (topological) order, and
    # scope this cycle's pressures to the service(s) their evidence touches —
    # grouped per-service in that same order (ORPHAN-MEDIUM-259). Cached by graph
    # fingerprint (no re-scan when the project graph is unchanged); skipped when
    # there is neither a change nor a pressure. Never fails the cycle.
    service_examination: dict[str, Any] = {}
    if not discovery_only:
        try:
            changed_paths = (diff.get("changed_paths") if isinstance(diff, dict) else None) or []
            cycle_pressures = pressure.get("pressures") if isinstance(pressure, dict) else None
            if changed_paths or cycle_pressures:
                emit_progress("service_examination", cycle_id=cycle_id, phase="started",
                              changed_paths=len(changed_paths), pressures=len(cycle_pressures or []))
                service_examination = cycle_service_examination(
                    workspace_root=workspace_root, base_dir=root,
                    changed_files=changed_paths, pressures=cycle_pressures,
                )
        except Exception:
            service_examination = {}
    try:
        learning_post = run_learning_post_evidence_closure(workspace, cycle_id=cycle_id, tools_root=root)
    except Exception as exc:
        learning_post = {"schema_version": 1, "cycle_id": cycle_id, "status": "failed", "error": str(exc), "hooks": []}
        if post_tool_failure is None:
            post_tool_failure = {"phase": "learning_post_evidence_closure", "status": "failed", "error": str(exc)}
    learning = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "pre_cycle": learning_pre,
        "post_evidence_closure": learning_post,
        "hooks": list(learning_pre.get("hooks", [])) + list(learning_post.get("hooks", [])),
    }
    artifact_integrity = verify_artifacts(base_dir=root)
    non_ok_runs = [
        run for run in run_summary
        if run.get("status") != "ok" or run.get("artifact_status") in {"missing", "hash_mismatch", "write_failed"}
    ]
    runtime_status = "ok" if not non_ok_runs and artifact_integrity.get("valid") else "integrity_failed"
    if post_tool_failure is not None:
        runtime_status = "failed"
    try:
        metrics = record_cycle_metrics(
            cycle_id=cycle_id,
            phase_durations_ms={"cycle": int((time.monotonic() - started) * 1000)},
            artifact_count=len(run_summary) + 4,
            status="ok" if runtime_status == "ok" else "failed",
            cost_units=sum(float((decision.get("envelope") or {}).get("cost_units") or 0) for decision in decisions if isinstance(decision, dict)),
            base_dir=root,
        )
    except Exception as exc:
        metrics = {"schema_version": 1, "cycle_id": cycle_id, "status": "failed", "error": str(exc)}
        if post_tool_failure is None:
            post_tool_failure = {"phase": "metrics", "status": "failed", "error": str(exc)}
        runtime_status = "failed"
    try:
        dashboard = generate_observability_dashboard(cycle_id=cycle_id, base_dir=root)
    except Exception as exc:
        dashboard = {"schema_version": 1, "cycle_id": cycle_id, "status": "failed", "error": str(exc)}
        if post_tool_failure is None:
            post_tool_failure = {"phase": "observability_dashboard", "status": "failed", "error": str(exc)}
        runtime_status = "failed"

    # Plan 022 §M-1 — extended-phase dispatch. Default behaviour
    # (run_phases=None) is unchanged; only when the operator opts into
    # extra phases do we invoke the architecture spine gate +
    # validation matrix + PR lifecycle from inside the cycle.
    extended_phase_results: dict[str, Any] = {}
    if run_phases is not None:
        active_phases = tuple(run_phases)
        unknown = [p for p in active_phases if p not in SUPPORTED_CYCLE_PHASES]
        if unknown:
            raise ValueError(
                f"unknown cycle phase(s): {unknown}; "
                f"supported phases: {SUPPORTED_CYCLE_PHASES}"
            )
        extended_phase_results = _run_extended_phases(
            phases=active_phases,
            workspace_root=Path(workspace_root).resolve(),
            cycle_id=cycle_id,
            base_dir=root,
            plan_id=plan_id,
            cycle_started_at=cycle_started_at,
        )

    # Plan 025 §C — cycle status propagation. If any extended phase
    # returned ``status=="fail"`` the cycle's terminal row is written
    # via _failed_event (factory at line 161); otherwise the
    # legacy _complete_event happy path. Pre-fix _complete_event was
    # called unconditionally — a failed validation_matrix or
    # pr_lifecycle phase silently passed through to a "completed"
    # cycle, defeating the purpose of running the gate.
    phase_failures = [
        name for name, result in extended_phase_results.items()
        if isinstance(result, dict) and result.get("status") == "fail"
    ]
    failed_phases = [
        {"phase": str(name), "status": "failed"}
        for name in phase_failures
    ]
    if post_tool_failure is not None:
        failed_phases.append(post_tool_failure)
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
    # ORPHAN-HIGH-339 — read AFTER this cycle's terminal row is appended
    # (both branches above write one), so the snapshot counts only cycles
    # that were genuinely abandoned. Carried whole, not just as a count:
    # when `cycles.jsonl` cannot be read at all the count is 0 but
    # `valid` is False, and a consumer that sees only the number would
    # report "no incomplete cycles" for an unreadable ledger.
    cycle_lifecycle = _cycle_lifecycle_snapshot(root)
    state = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "status": state_status,
        "runtime_status": runtime_status,
        "extended_phase_failures": phase_failures,
        "failed_phases": failed_phases,
        "event": event,
        "learning": learning,
        "discovery": discovery,
        "cycle_diff": diff,
        "service_examination": service_examination,
        "memory": memory,
        "belief_decay": belief_decay,
        "pressure": pressure,
        "consensus_escalation": consensus_escalation,
        "judge_calibration": judge_calibration,
        "proactive_priorities": proactive_priorities,
        "reflection": reflection,
        "cycle_metrics": metrics,
        "observability_dashboard": dashboard,
        "artifact_integrity": artifact_integrity,
        "artifact_refs": [run["artifact_ref"] for run in run_summary if isinstance(run.get("artifact_ref"), dict)],
        "non_ok_tools": non_ok_runs,
        # ORPHAN-HIGH-339 — derived, not pinned. Pre-fix this was the
        # literal 0 that runtime_artifacts then summed across cycles, so a
        # cycle killed mid-run stayed invisible in every operator-facing
        # summary while `integrity verify` could already see it.
        "incomplete_lifecycle_count": int(cycle_lifecycle.get("incomplete_count") or 0),
        "cycle_lifecycle": cycle_lifecycle,
        "tool_decisions": decisions,
        "tool_governance_decisions": decisions,
        "tool_run_summary": run_summary,
        "extended_phases": extended_phase_results,
        "pre_phase_results": pre_phase_results,
    }
    _write_workspace_cycle_artifact(workspace, _workspace_cycle_state(workspace, state))
    return state


def _run_extended_phases(
    *,
    phases: tuple[str, ...],
    workspace_root: Path,
    cycle_id: str,
    base_dir: Path,
    plan_id: str | None,
    cycle_started_at: datetime | None = None,
) -> dict[str, Any]:
    """Plan 022 §M-1 — opt-in extended phase chain.

    Each extended phase calls the corresponding kernel primitive that
    already exists as a public API (Plan 020 Phase 4 fresh
    orchestrator + Phase 8 validation matrix gate + Plan 016 PR
    lifecycle). The cycle becomes the orchestrator that strings them
    together; primitives unchanged.
    """
    out: dict[str, Any] = {}
    if plan_id is None:
        # architecture_baseline / postcheck require a plan_id; emit a
        # skip notice so the operator knows why the phase didn't fire.
        skip = {"status": "skipped", "reason": "plan_id_required"}
        if "architecture_baseline" in phases:
            out["architecture_baseline"] = skip
        if "architecture_postcheck" in phases:
            out["architecture_postcheck"] = skip
    else:
        if "architecture_baseline" in phases:
            from .architecture_spine_gate import take_baseline
            out["architecture_baseline"] = take_baseline(
                plan_id=plan_id, cycle_id=cycle_id,
                workspace_root=workspace_root, base_dir=base_dir,
            )
        if "architecture_postcheck" in phases:
            from .architecture_spine_gate import take_postcheck
            out["architecture_postcheck"] = take_postcheck(
                plan_id=plan_id, cycle_id=cycle_id,
                workspace_root=workspace_root, base_dir=base_dir,
            )
    if "validation_matrix" in phases:
        # Plan 025 §C — closed-loop wiring. Pre-fix this branch emitted
        # only an informational notice ("invoke the matrix CLI outside
        # the cycle"); the cycle never actually invoked enforce_
        # validation_matrix even though the kernel primitive existed.
        # The fix is per-change_id discovery (bounded by cycle window)
        # + per-change gate invocation + aggregated per-id results.
        # Failure of ANY change_id's matrix gate downgrades the cycle
        # terminal status via _failed_event (see run_enterprise_cycle
        # status propagation).
        out["validation_matrix"] = _run_validation_matrix_phase(
            cycle_started_at=cycle_started_at,
            workspace_root=workspace_root,
            base_dir=base_dir,
        )
    if "pr_lifecycle" in phases:
        # Plan 025 §C — closed-loop wiring. Pre-fix this branch emitted
        # only an informational notice ("invoke the PR CLI outside the
        # cycle"); the cycle never invoked pr_manager.open_pr_for_
        # action even though the primitive existed. The fix is
        # per-proposal discovery (filtering on status=approved_for_
        # apply) + per-proposal dry-run action + aggregated per-id
        # results. Failure of ANY proposal action downgrades the
        # cycle terminal status. Live PR open is operator-explicit
        # (dry_run=True default; live mode is out of cycle scope).
        out["pr_lifecycle"] = _run_pr_lifecycle_phase(
            workspace_root=workspace_root,
            base_dir=base_dir,
        )
    return out


def _run_validation_matrix_phase(
    *,
    cycle_started_at: datetime | None,
    workspace_root: Path,
    base_dir: Path,
) -> dict[str, Any]:
    """Plan 025 §C — invoke enforce_validation_matrix per change_id
    committed inside the cycle window.

    cycle_started_at = None (legacy callers) → no_op. Production
    callers (run_enterprise_cycle) always pass a UTC datetime.

    Returns per-id aggregate dict with ``status`` ∈
    {``no_op``, ``ok``, ``fail``}. ``fail`` propagates to the cycle's
    terminal status via the _complete_event-vs-_failed_event branch
    in run_enterprise_cycle.

    GovernanceError from enforce_validation_matrix is caught per
    change_id so a single failure does not abort the entire phase
    (operator sees every change's outcome, not just the first
    failure).
    """
    from .change_ledger import (
        get_change_chain,
        list_committed_change_ids_in_window,
    )
    from .validation_matrix_gate import enforce_validation_matrix

    if cycle_started_at is None:
        return {
            "status": "no_op",
            "total": 0, "ok": 0, "fail": 0,
            "change_ids": [],
            "reason": "cycle_started_at_required",
        }
    change_ids = list_committed_change_ids_in_window(
        since=cycle_started_at, base_dir=base_dir,
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


def _run_pr_lifecycle_phase(
    *,
    workspace_root: Path,
    base_dir: Path,
) -> dict[str, Any]:
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
    """
    from .pr_manager import open_pr_for_action
    from .proposal import list_proposals

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


def _cycle_lifecycle_snapshot(root: Path) -> dict[str, Any]:
    """ORPHAN-HIGH-339 — started-without-terminal snapshot for the summary.

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
