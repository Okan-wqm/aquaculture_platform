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
from .learning import run_learning_pass
from .workspace import WorkspacePaths, ensure_workspace, workspace_paths
from .discovery import run_discovery
from .cycle_diff import run_cycle_diff
from .memory import update_memory
from .observability import generate_observability_dashboard, record_cycle_metrics
from .pressure import run_pressure
from .reflection import run_reflection
from .tool_health import load_jsonl, runs_path
from .tool_registry import ensure_tools_binding, list_tools, utc_now
from .tool_runner import run_tool
from .ledger import append_jsonl


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
) -> dict[str, Any]:
    # Plan 023 v3 §R-1 — pre_tool_phases kwarg runs extended phases
    # BEFORE the tool loop. Pre-Plan-023 all extended phases ran
    # AFTER tools, so architecture_baseline / validation_matrix_pre /
    # pr_lifecycle_pre observed consequences instead of preconditions
    # and could not gate tool dispatch. Post-fix: pre_tool_phases
    # fires first; failure aborts the cycle with cycle_aborted_by_
    # pre_phase. The legacy run_phases kwarg continues to run AFTER
    # tools (post-tool observation).
    started = time.monotonic()
    root = ensure_tools_binding(base_dir, workspace_root=workspace_root)
    if (root / "ARIA_STOP").exists():
        # Plan 024 §E — ARIA_STOP path used to return without
        # appending a terminal row to cycles.jsonl, leaving the cycle
        # "open forever" against integrity._verify_cycle_lifecycle.
        # We persist a typed `stopped` terminal row before returning
        # so cycle lifecycle integrity holds for stop-aborted cycles.
        append_jsonl(root / "cycles.jsonl", _stopped_event(cycle_id))
        return {
            "schema_version": 2,
            "cycle_id": cycle_id,
            "event": "stopped",
            "status": "stopped",
        }
    workspace = _ensure_enterprise_workspace(workspace_root, workspace_base, root)
    git_head_sha_at_cycle = _git_head_sha(Path(workspace_root))
    append_jsonl(root / "cycles.jsonl", _started_cycle_row(cycle_id=cycle_id))
    learning = run_learning_pass(workspace, cycle_id=cycle_id, tools_root=root)
    discovery = run_discovery(workspace_root=workspace_root, cycle_id=cycle_id, base_dir=root, snapshot_mode=snapshot_mode)
    diff = run_cycle_diff(cycle_id=cycle_id, base_dir=root)
    if discovery_only:
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
                append_jsonl(root / "cycles.jsonl", event)
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
    for run in load_jsonl(runs_path(root)):
        if run.get("cycle_id") != cycle_id:
            continue
        run_summary.append(
            {
                "tool_id": run.get("tool_id"),
                "status": run.get("status"),
                "raw_findings_count": int(run.get("runner", {}).get("raw_findings_count") or 0),
                "raw_observations_count": int(run.get("runner", {}).get("raw_observations_count") or 0),
                "emitted_findings_count": len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0,
                "emitted_observations_count": len(run.get("emitted_observations", [])) if isinstance(run.get("emitted_observations"), list) else 0,
            },
        )
    memory = update_memory(cycle_id=cycle_id, base_dir=root)
    pressure = run_pressure(cycle_id=cycle_id, base_dir=root)
    reflection = run_reflection(cycle_id=cycle_id, base_dir=root, repo_root=workspace_root)
    metrics = record_cycle_metrics(
        cycle_id=cycle_id,
        phase_durations_ms={"cycle": int((time.monotonic() - started) * 1000)},
        artifact_count=len(run_summary) + 4,
        status="ok",
        base_dir=root,
    )
    dashboard = generate_observability_dashboard(cycle_id=cycle_id, base_dir=root)

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
        )

    event = _complete_event(root, cycle_id, len(decisions), git_head_sha_at_cycle=git_head_sha_at_cycle)
    state = {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "git_head_sha_at_cycle": git_head_sha_at_cycle,
        "status": "completed",
        "event": event,
        "learning": learning,
        "discovery": discovery,
        "cycle_diff": diff,
        "memory": memory,
        "pressure": pressure,
        "reflection": reflection,
        "cycle_metrics": metrics,
        "observability_dashboard": dashboard,
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
        # Validation matrix is applied per change_id; the cycle entry
        # point can't pick a specific change. Emit an informational
        # row pointing the operator at the matrix CLI.
        out["validation_matrix"] = {
            "status": "informational",
            "notice": "validation_matrix is per change_id; invoke "
                      "`aria-kernel validation-matrix check --change-id <id>` "
                      "outside the cycle.",
        }
    if "pr_lifecycle" in phases:
        out["pr_lifecycle"] = {
            "status": "informational",
            "notice": "pr_lifecycle requires proposal_id; invoke "
                      "`aria-kernel pr create --proposal-id <id>` "
                      "outside the cycle.",
        }
    return out


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
    append_jsonl(root / "cycles.jsonl", row)
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
