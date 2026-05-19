"""Plan 026R §F.1 — unified autonomy orchestrator (LOAD-BEARING).

Operator vision center-piece: "gün sonunda otonom — problemi
bulup çözecek, her adımı loglayacak, plan açacak, agent yazacak,
skill yazacak". Pre-§F.1 the kernel had:

* ``cycle.run_enterprise_cycle`` — discovery + tools + reflection
* ``autonomous_planner_dispatcher.run_planner_dispatch_daemon`` —
  planner claim+dispatch loop (Plan 025 §D)
* ``autonomous_worker_scheduler.run_worker_scheduler_daemon`` —
  worker claim+verify+merge loop (Plan 025 §E)
* ``validation_matrix_gate`` + ``pr_manager`` + ``auto_merge`` —
  discrete primitives

…but no unified binder. §F.1 supplies the missing full-chain
orchestrator that drives one autonomy cycle end-to-end:

  1. ARIA_STOP — operator-visible halt (highest priority)
  2. profile gate — frozen/observe → clean exit
  3. drain next_cycle_queue (§F.2) into agent-invocation requests
  4. run cycle phase — invokes ``run_enterprise_cycle``
  5. drain planner-dispatch — bounded planner-daemon iterations
  6. drain bridge (Plan 026R §C.5) — retry pending bridge rows
  7. drain worker-dispatch — bounded worker-daemon iterations
  8. validation + PR-lifecycle + auto-merge (D.1+D.3+D.4)
  9. emit ``cycle_completed`` transition + repeat until max_cycles

Each transition appends a row to ``autonomy_state.jsonl`` via
``AutonomyStateReducer.transition`` so the canonical state surface
(§F.3) stays consistent across cycles. Each row is hash-chain
bound via §A.1 ``append_jsonl``.

Single-instance discipline: fcntl lock on
``aria-tools/daemons/<daemon_id>.pid.lock`` — second instance
returns clean (``exits_clean=False, exit_reason='daemon_already_running'``).

Injection seams for tests:

* ``cycle_runner`` — defaults to ``cycle.run_enterprise_cycle``
* ``planner_drainer`` — defaults to
  ``autonomous_planner_dispatcher.run_planner_dispatch_daemon``
* ``worker_drainer`` — defaults to
  ``autonomous_worker_scheduler.run_worker_scheduler_daemon``
* ``bridge_drainer`` — defaults to
  ``bridge_status_ledger.replay_pending_bridges`` if present else
  a no-op (graceful degrade when bridge surface absent)
* ``auto_merge_runner`` — optional; orchestrator skips auto-merge
  when None (default), since auto-merge requires a change_id flow
  that the orchestrator does not synthesize unilaterally

All other args mirror the §D + §E daemon contract for surface
parity.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .autonomy_state import AutonomyStateReducer
from .file_lock import with_exclusive_lock
from .next_cycle_queue import mark_consumed, read_pending


__all__ = [
    "DEFAULT_DAEMON_ID",
    "DEFAULT_MAX_CYCLES",
    "DEFAULT_MAX_ITERATIONS_PER_PHASE",
    "run_autonomy_orchestrator",
]


DEFAULT_DAEMON_ID: str = "autonomy"
DEFAULT_MAX_CYCLES: int = 1
DEFAULT_MAX_ITERATIONS_PER_PHASE: int = 10
_DAEMON_LOCK_TIMEOUT_SECONDS: float = 2.0
_ORCHESTRATOR_ACTION_KIND: str = "agent_claim"


def _iso_now() -> str:
    return (
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )


def _default_bridge_drainer(
    *,
    base_dir: Path,
    max_iterations: int,
) -> dict[str, Any]:
    """Default bridge drainer — best-effort C.5 retry loop.

    The bridge surface lives in ``bridge_status_ledger.py``; the
    retry primitive may not exist in every kernel version. We
    look up ``replay_pending_bridges`` if present, otherwise
    return a no-op success row so the orchestrator can still
    advance.
    """
    try:
        from . import bridge_status_ledger
    except ImportError:
        return {
            "status": "skipped",
            "reason": "bridge_status_ledger_unavailable",
            "iterations": 0,
        }
    replay_fn = getattr(
        bridge_status_ledger, "replay_pending_bridges", None,
    )
    if replay_fn is None:
        return {
            "status": "skipped",
            "reason": "replay_pending_bridges_unavailable",
            "iterations": 0,
        }
    result = replay_fn(base_dir=base_dir, max_iterations=max_iterations)
    if not isinstance(result, dict):
        return {"status": "ok", "iterations": 0}
    return result


def _drain_next_cycle_queue(
    *,
    base_dir: Path,
    daemon_agent_id: str,
    limit: int,
) -> int:
    """Drain pending §F.2 queue items.

    Marks each pending item as consumed by the orchestrator.
    Returns the count drained — caller emits a single transition
    row carrying the count.

    NOTE: pre-§F.1 there was no consumer for ``next_cycle_queue``;
    drain currently marks-and-counts but does NOT yet synthesize
    agent-invocation requests (that wire goes through the planner
    dispatcher per Plan 025 §D contract). The drain prevents
    queue-bloat and surfaces the volume as a metric; the routing
    upgrade lands once the planner-dispatch hook accepts
    queue-derived pressure inputs.
    """
    pending = read_pending(base_dir, limit=limit)
    for item in pending:
        qid = item.get("queue_item_id")
        if not isinstance(qid, str) or not qid:
            continue
        mark_consumed(
            base_dir,
            queue_item_id=qid,
            consumed_by=daemon_agent_id,
        )
    return len(pending)


def run_autonomy_orchestrator(
    *,
    base_dir: str | Path,
    workspace_root: str | Path | None = None,
    max_cycles: int = DEFAULT_MAX_CYCLES,
    max_iterations_per_phase: int = DEFAULT_MAX_ITERATIONS_PER_PHASE,
    daemon_id: str = DEFAULT_DAEMON_ID,
    aria_stop_filename: str = "ARIA_STOP",
    cycle_runner: Callable[..., dict[str, Any]] | None = None,
    planner_drainer: Callable[..., dict[str, Any]] | None = None,
    worker_drainer: Callable[..., dict[str, Any]] | None = None,
    bridge_drainer: Callable[..., dict[str, Any]] | None = None,
    auto_merge_runner: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Plan 026R §F.1 LOAD-BEARING — run one or more autonomy cycles.

    Returns a structured summary with per-cycle phase results +
    counters + the canonical exit reason. Cleanly exits on:

    * ``aria_stop`` — operator wrote the ARIA_STOP file
    * ``profile_frozen`` — runtime profile gate raised
    * ``max_cycles`` — reached the cycle cap
    * ``daemon_already_running`` — single-instance lock contended
    """
    from .runtime_profile import enforce_profile_for_action, get_profile
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )

    if cycle_runner is None:
        from .cycle import run_enterprise_cycle
        cycle_runner = run_enterprise_cycle
    if planner_drainer is None:
        from .autonomous_planner_dispatcher import (
            run_planner_dispatch_daemon,
        )
        planner_drainer = run_planner_dispatch_daemon
    if worker_drainer is None:
        from .autonomous_worker_scheduler import (
            run_worker_scheduler_daemon,
        )
        worker_drainer = run_worker_scheduler_daemon
    if bridge_drainer is None:
        bridge_drainer = _default_bridge_drainer

    root = ensure_tools_dir(base_dir)
    daemons_dir = root / "daemons"
    daemons_dir.mkdir(parents=True, exist_ok=True)
    daemon_pid_path = daemons_dir / f"{daemon_id}.pid.lock"
    aria_stop_path = root / aria_stop_filename
    daemon_agent_id = f"daemon:{daemon_id}:{os.getpid()}"

    cycles_completed = 0
    planner_total = 0
    worker_total = 0
    auto_merges_total = 0
    exit_reason = "max_cycles"
    per_cycle_results: list[dict[str, Any]] = []
    profile_snapshot = get_profile(base_dir=root)

    try:
        with with_exclusive_lock(
            daemon_pid_path,
            timeout_seconds=_DAEMON_LOCK_TIMEOUT_SECONDS,
        ):
            # Plan 026R §F.1 + §A.4 — under frozen profile,
            # `append_tools_governance` is itself blocked (it routes
            # through `enforce_profile_for_write('tool_governance')`).
            # The orchestrator's own canonical state surface
            # (`autonomy_state.jsonl` via `AutonomyStateReducer`) is
            # NOT gated by profile, so a frozen-profile invocation
            # still records the `profile_frozen` transition + exits
            # clean. Emitting the orchestrator-started governance
            # announce only under a permitting profile keeps the
            # frozen-bypass invariant intact.
            profile_announce_allowed = profile_snapshot not in {
                "frozen", "observe",
            }
            if profile_announce_allowed:
                append_tools_governance(
                    root, "autonomy_orchestrator_started",
                    {
                        "daemon_id": daemon_id,
                        "daemon_agent_id": daemon_agent_id,
                        "max_cycles": max_cycles,
                        "max_iterations_per_phase":
                            max_iterations_per_phase,
                        "started_at": _iso_now(),
                        "profile": profile_snapshot,
                    },
                )

            for cycle_n in range(max_cycles):
                # ARIA_STOP precedes the profile gate (matches
                # daemons + cycle.py:244 ordering).
                if aria_stop_path.exists():
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=None,
                        phase="aria_stop",
                        status="ok",
                        profile=profile_snapshot,
                        details={
                            "cycle_index": cycle_n,
                            "daemon_id": daemon_id,
                        },
                    )
                    exit_reason = "aria_stop"
                    break

                try:
                    enforce_profile_for_action(
                        _ORCHESTRATOR_ACTION_KIND, base_dir=root,
                    )
                except GovernanceError:
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=None,
                        phase="profile_frozen",
                        status="ok",
                        profile=profile_snapshot,
                        details={
                            "cycle_index": cycle_n,
                            "daemon_id": daemon_id,
                        },
                    )
                    exit_reason = "profile_frozen"
                    break

                cycle_id = datetime.now(timezone.utc).strftime(
                    "cyc-%Y%m%dT%H%M%SZ-auto",
                )
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="cycle_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={
                        "cycle_index": cycle_n,
                        "daemon_id": daemon_id,
                    },
                )

                # Phase: drain next_cycle_queue (§F.2)
                drained = _drain_next_cycle_queue(
                    base_dir=root,
                    daemon_agent_id=daemon_agent_id,
                    limit=max_iterations_per_phase,
                )
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="next_cycle_queued",
                    status="ok",
                    profile=profile_snapshot,
                    details={
                        "drained_count": drained,
                    },
                )

                cycle_summary: dict[str, Any] = {
                    "cycle_id": cycle_id,
                    "cycle_index": cycle_n,
                    "queue_drained": drained,
                }

                # Phase: run cycle (discovery + tools + reflection).
                try:
                    cycle_result = cycle_runner(
                        workspace_root=workspace_root,
                        cycle_id=cycle_id,
                        base_dir=root,
                    )
                    cycle_summary["cycle"] = cycle_result
                    cycle_status = "ok"
                except Exception as exc:
                    cycle_summary["cycle"] = {
                        "status": "failed",
                        "error": str(exc),
                    }
                    cycle_status = "failed"
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="cycle_completed",
                    status=cycle_status,
                    profile=profile_snapshot,
                    details={
                        "summary": cycle_summary.get("cycle"),
                    },
                )
                if cycle_status == "ok":
                    cycles_completed += 1

                # Phase: planner dispatch drain (bounded).
                planner_result = planner_drainer(
                    base_dir=root,
                    workspace_root=workspace_root,
                    max_iterations=max_iterations_per_phase,
                )
                planner_claims = int(
                    planner_result.get("claims_dispatched") or 0,
                )
                planner_total += planner_claims
                cycle_summary["planner_dispatch"] = planner_result
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="planner_dispatch_drained",
                    status=str(
                        planner_result.get("exit_reason") or "ok",
                    ),
                    planner_claims_delta=planner_claims,
                    profile=profile_snapshot,
                    details={
                        "iterations": planner_result.get("iterations"),
                    },
                )

                # Phase: bridge drain (C.5 retry).
                bridge_result = bridge_drainer(
                    base_dir=root,
                    max_iterations=max_iterations_per_phase,
                )
                cycle_summary["bridge"] = bridge_result
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="bridge_drained",
                    status=str(bridge_result.get("status") or "ok"),
                    pending_bridge_count=int(
                        bridge_result.get("pending_after") or 0,
                    ),
                    profile=profile_snapshot,
                    details={
                        "iterations": bridge_result.get("iterations"),
                    },
                )

                # Phase: worker dispatch drain (bounded).
                worker_result = worker_drainer(
                    base_dir=root,
                    workspace_root=workspace_root,
                    max_iterations=max_iterations_per_phase,
                )
                worker_assignments = int(
                    worker_result.get("assignments_dispatched") or 0,
                )
                worker_merges = int(
                    worker_result.get("merges_completed") or 0,
                )
                worker_total += worker_assignments
                auto_merges_total += worker_merges
                cycle_summary["worker_dispatch"] = worker_result
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="worker_dispatch_drained",
                    status=str(
                        worker_result.get("exit_reason") or "ok",
                    ),
                    worker_assignments_delta=worker_assignments,
                    auto_merges_delta=worker_merges,
                    profile=profile_snapshot,
                    details={
                        "iterations": worker_result.get("iterations"),
                        "retries":
                            worker_result.get("retries_attempted"),
                    },
                )

                # Phase: optional auto-merge (skipped when no runner).
                if auto_merge_runner is not None:
                    auto_merge_result = auto_merge_runner(
                        base_dir=root,
                        workspace_root=workspace_root,
                    )
                    extra_merges = int(
                        auto_merge_result.get("merges_completed") or 0,
                    )
                    auto_merges_total += extra_merges
                    cycle_summary["auto_merge"] = auto_merge_result
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="auto_merge_completed",
                        status=str(
                            auto_merge_result.get("status") or "ok",
                        ),
                        auto_merges_delta=extra_merges,
                        profile=profile_snapshot,
                        details={},
                    )

                per_cycle_results.append(cycle_summary)

            else:
                # for-else: ran every iteration without break.
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=None,
                    phase="max_cycles_reached",
                    status="ok",
                    profile=profile_snapshot,
                    details={"max_cycles": max_cycles},
                )

            if profile_announce_allowed:
                append_tools_governance(
                    root, "autonomy_orchestrator_exit",
                    {
                        "daemon_id": daemon_id,
                        "cycles_completed": cycles_completed,
                        "planner_claims_dispatched": planner_total,
                        "worker_assignments_dispatched": worker_total,
                        "auto_merges_completed": auto_merges_total,
                        "exit_reason": exit_reason,
                    },
                )

            return {
                "cycles_completed": cycles_completed,
                "planner_claims_dispatched": planner_total,
                "worker_assignments_dispatched": worker_total,
                "auto_merges_completed": auto_merges_total,
                "exit_reason": exit_reason,
                "exits_clean": True,
                "per_cycle": per_cycle_results,
                "daemon_agent_id": daemon_agent_id,
            }
    except TimeoutError:
        append_tools_governance(
            root, "autonomy_orchestrator_lock_contended",
            {
                "daemon_id": daemon_id,
                "lock_path": str(daemon_pid_path),
            },
        )
        return {
            "cycles_completed": 0,
            "planner_claims_dispatched": 0,
            "worker_assignments_dispatched": 0,
            "auto_merges_completed": 0,
            "exit_reason": "daemon_already_running",
            "exits_clean": False,
            "per_cycle": [],
            "daemon_agent_id": daemon_agent_id,
        }
