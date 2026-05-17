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
* ``auto_merge_runner`` — REQUIRED (Plan ARIA-V3 §A1 GAP-2 closure).
  Pre-V3 this was optional with a ``None`` default that silently
  skipped auto-merge; V3 makes it required so the orchestrator's
  loop is well-defined under the type system. Profile-derived
  selection lives in ``auto_merge_runners.select_auto_merge_runner``
  (NoOp for observe/standard/frozen; Real wrapping merge_if_green
  for strict/autonomous). Invariant I-V3-01 locks the
  required-parameter contract.

All other args mirror the §D + §E daemon contract for surface
parity.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .autonomy_state import AutonomyStateReducer
from .file_lock import with_exclusive_lock
from .next_cycle_queue import mark_consumed, read_pending
from .reflection import run_reflection

if TYPE_CHECKING:
    # Plan ARIA-V3 §A1 — typed-only import keeps the annotation
    # load-bearing without a runtime cycle (auto_merge_runners
    # imports from auto_merge which imports from this module's
    # peers; TYPE_CHECKING avoids a circular import at runtime).
    from .auto_merge_runners import AutoMergeRunner
    # Plan ARIA-V5 §3c v2 — ConvergenceRunner Protocol typed-only
    # import. Same TYPE_CHECKING discipline as auto_merge_runners
    # above: the convergence_drainer module imports from
    # plan_convergence + convergent_planning_bridge which import
    # from tool_registry which imports from this module's peers.
    from .convergence_drainer import ConvergenceRunner
    # Plan ARIA-V5 §3d v2 — ReviewRunner Protocol typed-only import.
    # Same TYPE_CHECKING discipline; review_runner imports from
    # agent_invocations which imports from ledger.
    from .review_runner import ReviewRunner
    # Plan ARIA-V6 §2c v2 — SpecialistReviewRunner Protocol typed-
    # only import (Gate C Lane-A dispatch). Same TYPE_CHECKING
    # discipline as other runners.
    from .specialist_review_runner import SpecialistReviewRunner
    # Plan ARIA-V7 §2i v2 — PlanSynthesizer Protocol typed-only
    # import (cycle_runner plan_content producer). Same TYPE_CHECKING
    # discipline. The synthesizer is a REQUIRED kwarg per V5/V6 §A1
    # precedent and the source-substring invariant I-V7.1-04 pins
    # the contract.
    from .plan_synthesizer import PlanSynthesizer


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


def _autonomous_preflight(
    *,
    base_dir: Path,
    profile_snapshot: str,
) -> tuple[str, str | None]:
    """Plan ARIA-V3 §B2 — cost + failure + lease preflight.

    Returns ``("ok", None)`` when the cycle is permitted to enter the
    autonomous path; ``("blocked", reason_code)`` when refused. Non-
    autonomous profiles short-circuit OK (the preflight is autonomous-
    only — strict/standard/observe/frozen have their own gates).

    Reason codes (exit_reason values):
      * ``cost_breaker_tripped`` — B0 cost circuit breaker tripped
      * ``failure_breaker_tripped`` — B2 failure circuit breaker tripped
      * ``autonomous_host_lease_blocked`` — §2n cross-host lease held
        by a different host
    """
    if profile_snapshot != "autonomous":
        return ("ok", None)
    # Lazy imports — keep run_autonomy_orchestrator importable when
    # the new B2 modules are absent (e.g. cold downgrade scenarios).
    try:
        from .cost_budget import current_state as _cost_state
        if _cost_state(base_dir) == "tripped":
            return ("blocked", "cost_breaker_tripped")
    except ImportError:
        pass
    try:
        from .circuit_breaker import current_state as _failure_state
        if _failure_state(base_dir) == "tripped":
            return ("blocked", "failure_breaker_tripped")
    except ImportError:
        pass
    try:
        from .autonomous_host_lease import acquire_lease
        from .tool_registry import GovernanceError as _GE
        try:
            acquire_lease(base_dir=base_dir)
        except _GE as exc:
            if "autonomous_host_lease_blocked" in str(exc):
                return ("blocked", "autonomous_host_lease_blocked")
            raise
    except ImportError:
        pass
    return ("ok", None)


def run_autonomy_orchestrator(
    *,
    base_dir: str | Path,
    auto_merge_runner: "AutoMergeRunner",
    github_adapter: Any,
    convergence_runner: "ConvergenceRunner",
    review_runner: "ReviewRunner",
    specialist_review_runner: "SpecialistReviewRunner",
    plan_synthesizer: "PlanSynthesizer",
    workspace_root: str | Path | None = None,
    max_cycles: int = DEFAULT_MAX_CYCLES,
    max_iterations_per_phase: int = DEFAULT_MAX_ITERATIONS_PER_PHASE,
    daemon_id: str = DEFAULT_DAEMON_ID,
    aria_stop_filename: str = "ARIA_STOP",
    cycle_runner: Callable[..., dict[str, Any]] | None = None,
    planner_drainer: Callable[..., dict[str, Any]] | None = None,
    worker_drainer: Callable[..., dict[str, Any]] | None = None,
    bridge_drainer: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    # Plan ARIA-V5 §3a v2 — ``convergence_runner`` is REQUIRED with NO
    # default (Tier-1 "Make impossible"). The kwarg mirrors the V3 §A1
    # ``auto_merge_runner`` + §A2 ``github_adapter`` precedent: every
    # caller must explicitly supply a runner. Operator-facing CLI uses
    # ``select_convergence_runner(profile)`` from
    # ``aria_kernel.convergence_drainer``; tests inject mock fakes
    # directly. The orchestrator does NOT silently default — a missing
    # kwarg becomes a TypeError at signature binding, NOT a silent
    # skip of the convergence gate.
    #
    # Why Tier-1 not Tier-2: the operator's V5 vision ("planları sureklı
    # en bastan revıew ederek ıkı agent bırbırıne atarak valıde sekılde
    # sonlanrmalı") demands convergence on EVERY cycle. A Tier-2
    # optional-with-None-default would let a future caller silently
    # bypass the gate. Required-kwarg + invariant I-V5-01 enforce the
    # contract structurally.
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

                # Plan ARIA-V3 §B2 — autonomous-profile preflight gate.
                # ONLY fires when profile == "autonomous"; non-autonomous
                # profiles short-circuit. The gate checks three breakers
                # in priority order:
                #   1. cost_budget (B0) — $cost overrun
                #   2. circuit_breaker (B2) — failure-count overrun
                #   3. autonomous_host_lease (§2n) — cross-host race
                # On any breaker tripped, exit cleanly with the matching
                # reason code (no error, no retry storm).
                preflight_status, preflight_reason = _autonomous_preflight(
                    base_dir=root,
                    profile_snapshot=profile_snapshot,
                )
                if preflight_status == "blocked":
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=None,
                        phase=preflight_reason or "autonomous_preflight_blocked",
                        status="ok",
                        profile=profile_snapshot,
                        details={
                            "cycle_index": cycle_n,
                            "daemon_id": daemon_id,
                            "preflight_reason": preflight_reason,
                        },
                    )
                    exit_reason = preflight_reason or "autonomous_preflight_blocked"
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

                # Phase: run cycle (discovery + tools; reflection is
                # deferred to post-drainer per V3.3 §2b — see the
                # post_drain_reflection block after auto_merge below).
                try:
                    cycle_result = cycle_runner(
                        workspace_root=workspace_root,
                        cycle_id=cycle_id,
                        base_dir=root,
                        defer_reflection=True,
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

                # Plan ARIA-V5 §2 V5.1 Phase 5.1 — Gate A pre-worker
                # convergence drainer. Drive primary↔challenger debate
                # until consensus arbiter or max_rounds; gate
                # worker_drainer on arbiter_verdict == "converged".
                #
                # Operator vision (Plan ARIA-V5 §1 verbatim):
                #   "planları sureklı en bastan revıew ederek ıkı agent
                #   bırbırıne atarak valıde sekılde sonlanrmalı"
                #
                # The convergence_runner is REQUIRED (Tier-1, no default
                # at signature). When verdict != "converged", the
                # remainder of this cycle (worker_drainer +
                # auto_merge_runner) is skipped; reflection still runs
                # so the operator-facing daily report records the
                # convergence-blocked status.
                # Plan ARIA-V7 §2i v2 Phase 7.1 — plan_synthesizer
                # produces real plan_content from workspace discovery
                # BEFORE Gate A fires. Pre-V7, the orchestrator
                # hardcoded ``plan_seed={"cycle_id": cycle_id}`` — a
                # 1-key sentinel that ``plan_convergence._validate_
                # plan_content`` rejected as malformed, crashing the
                # autonomous cycle (ORPHAN-HIGH-079). V7.1 wires the
                # producer side: real workspace deltas → 7-field
                # plan_content dict that passes the validator.
                #
                # When the synthesizer returns None (no workspace
                # pressure), emit ``cycle_runner_no_pressure`` phase
                # + skip Gate A + Gate C + worker + Gate B +
                # auto_merge for this cycle. Reflection still runs
                # (V3.3 §2b preservation).
                _v7_plan_content = plan_synthesizer(
                    cycle_id=cycle_id,
                    workspace_root=Path(workspace_root) if workspace_root else root,
                    base_dir=root,
                )
                if _v7_plan_content is None:
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="cycle_runner_no_pressure",
                        status="no_workspace_pressure",
                        profile=profile_snapshot,
                        details={"plan_id": f"plan-{cycle_id}"},
                    )
                    cycle_summary["plan_synthesizer"] = {
                        "status": "no_pressure", "plan_content": None,
                    }
                    post_drain_reflection = run_reflection(
                        cycle_id=cycle_id,
                        base_dir=root,
                        repo_root=workspace_root,
                        convergence_result=None,
                        review_result=None,
                    )
                    cycle_summary["reflection"] = post_drain_reflection
                    per_cycle_results.append(cycle_summary)
                    continue
                # Plan ARIA-V7 §2i v2 — synthesizer produced real plan.
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="cycle_runner_synthesized_plan",
                    status="ok",
                    profile=profile_snapshot,
                    details={
                        "plan_id": f"plan-{cycle_id}",
                        "affected_surfaces_count": len(
                            _v7_plan_content.get("affected_surfaces", [])
                        ),
                        "key_changes_count": len(
                            _v7_plan_content.get("key_changes", [])
                        ),
                    },
                )
                cycle_summary["plan_synthesizer"] = {
                    "status": "synthesized",
                    "affected_surfaces_count": len(
                        _v7_plan_content.get("affected_surfaces", [])
                    ),
                    "key_changes_count": len(
                        _v7_plan_content.get("key_changes", [])
                    ),
                }
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="convergence_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={"plan_id": f"plan-{cycle_id}"},
                )
                convergence_result = convergence_runner(
                    cycle_id=cycle_id,
                    base_dir=root,
                    workspace_root=workspace_root,
                    plan_id=f"plan-{cycle_id}",
                    plan_seed=_v7_plan_content,
                    must_satisfy=[{
                        "id": "cycle-impl-satisfies-scope",
                        "description":
                            "Implementation must satisfy the cycle's "
                            "must_satisfy contract derived from "
                            "discovery + planner output.",
                    }],
                    evidence_refs=[f"cycle:{cycle_id}"],
                    allowed_scope=[f"cycle/{cycle_id}"],
                    max_rounds=max_iterations_per_phase,
                )
                cycle_summary["convergence"] = convergence_result
                arbiter_verdict = convergence_result.get(
                    "arbiter_verdict", "split",
                )
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="convergence_resolved",
                    status=str(arbiter_verdict),
                    profile=profile_snapshot,
                    details={
                        "rounds_count":
                            convergence_result.get("rounds_count"),
                        "unsatisfied_count": len(
                            convergence_result.get("unsatisfied_items", [])
                        ),
                        "plan_id": convergence_result.get("plan_id"),
                    },
                )

                if arbiter_verdict != "converged":
                    # Plan ARIA-V5 §2 V5.1 — convergence did not pass.
                    # Skip worker_drainer + auto_merge_runner for this
                    # cycle. Reflection still runs (V3.3 §2b) so the
                    # daily report captures the convergence-blocked
                    # status; operator sees the verdict in
                    # cycle_summary["dispatch_blocked_reason"].
                    cycle_summary["dispatch_blocked_reason"] = (
                        f"convergence_{arbiter_verdict}"
                    )
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="convergence_blocked",
                        status=str(arbiter_verdict),
                        profile=profile_snapshot,
                        details={
                            "rounds_count":
                                convergence_result.get("rounds_count"),
                        },
                    )
                    # Plan ARIA-V3.3 §2b + V5.4 §3f — post-drain
                    # reflection STILL runs on convergence-blocked
                    # cycles so the daily report covers them. V5.4
                    # bumps reflection to schema v2 and injects the
                    # Gate A convergence_result so the operator-facing
                    # daily report shows WHY the cycle was blocked.
                    post_drain_reflection = run_reflection(
                        cycle_id=cycle_id,
                        base_dir=root,
                        repo_root=workspace_root,
                        convergence_result=convergence_result,
                        # review_result + pedagogy_lint_result are
                        # absent on convergence-blocked cycles (Gate
                        # B never fired); pass None explicitly so the
                        # reflection v2 sub-object renders post_impl
                        # as None.
                        review_result=None,
                    )
                    cycle_summary["reflection"] = post_drain_reflection
                    per_cycle_results.append(cycle_summary)
                    continue

                # Plan ARIA-V6 §2c V6.1 Phase 6.1 — Gate C Lane-A
                # specialist dispatch. Inserted between Gate A's
                # converged-verdict check and worker_drainer. The
                # specialist_review_runner mints N domain-expert
                # envelopes (pressure-driven selection), polls for
                # verdicts, and gates worker_drainer on the
                # consolidated verdict.
                #
                # Operator vision (Plan ARIA-V6 §1 verbatim):
                #   "planları sureklı en bastan revıew ederek
                #    ıkı agent bırbırıne atarak valıde sekılde
                #    sonlanrmalı"
                #
                # Profile gating (per Plan §2c step 3):
                #   * observe → never dispatch Tier-1; defensive
                #   * standard → dispatch all; specialists_unavailable
                #               proceeds (fail-open degraded)
                #   * strict   → specialists_unavailable BLOCKS
                #               (fail-closed; operator-requested gate)
                #   * autonomous → fail-open (degraded acceptable)
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="specialist_review_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={"plan_id": convergence_result.get("plan_id")},
                )
                _touched_services = list({
                    p.get("source", "") for p in (convergence_result.get("converged_plan", {}).get("must_satisfy") or [])
                }) or [f"cycle/{cycle_id}"]
                specialist_review_result = specialist_review_runner(
                    cycle_id=cycle_id,
                    base_dir=root,
                    workspace_root=workspace_root,
                    plan_id=convergence_result.get("plan_id") or f"plan-{cycle_id}",
                    convergence_id=convergence_result.get("convergence_id")
                    or convergence_result.get("plan_id")
                    or f"plan-{cycle_id}",
                    touched_services=_touched_services,
                    pressures=[],
                    profile=str(profile_snapshot or "standard"),
                    max_specialists_per_cycle=max_iterations_per_phase,
                )
                cycle_summary["specialist_review"] = specialist_review_result
                specialist_verdict = specialist_review_result.get(
                    "consolidated_verdict", "specialists_unavailable",
                )
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="specialist_review_resolved",
                    status=str(specialist_verdict),
                    profile=profile_snapshot,
                    details={
                        "specialists_dispatched_count": len(
                            specialist_review_result.get("specialists_dispatched", [])
                        ),
                        "specialists_timed_out_count": len(
                            specialist_review_result.get("specialists_timed_out", [])
                        ),
                    },
                )

                # Plan ARIA-V6 §2c v2 — profile-conditional verdict
                # gating. Strict profile fails closed on unavailable;
                # standard/autonomous fail open. Remediation_required
                # ALWAYS blocks regardless of profile.
                _is_strict = str(profile_snapshot) == "strict"
                _blocks_cycle = specialist_verdict in {
                    "consolidated_remediation_required",
                    "consolidated_judge_split",
                } or (
                    _is_strict and specialist_verdict == "specialists_unavailable"
                )
                if _blocks_cycle:
                    cycle_summary["dispatch_blocked_reason"] = (
                        f"specialist_{specialist_verdict}"
                    )
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="specialist_review_blocked",
                        status=str(specialist_verdict),
                        profile=profile_snapshot,
                        details={
                            "specialists_dispatched_count": len(
                                specialist_review_result.get("specialists_dispatched", [])
                            ),
                        },
                    )
                    # Reflection still runs (V3.3 §2b + V5.4 §3f)
                    # on specialist-blocked cycles so daily report
                    # covers them.
                    post_drain_reflection = run_reflection(
                        cycle_id=cycle_id,
                        base_dir=root,
                        repo_root=workspace_root,
                        convergence_result=convergence_result,
                        review_result=None,
                    )
                    cycle_summary["reflection"] = post_drain_reflection
                    per_cycle_results.append(cycle_summary)
                    continue

                # Phase: worker dispatch drain (bounded).
                # Plan ARIA-V3 §A2 — github_adapter is REQUIRED;
                # plumbed through to the scheduler daemon which
                # passes it to dispatch_one_pending_worker_assignment.
                worker_result = worker_drainer(
                    base_dir=root,
                    workspace_root=workspace_root,
                    max_iterations=max_iterations_per_phase,
                    github_adapter=github_adapter,
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

                # Plan ARIA-V5 §2 V5.2 Phase 5.2 — Gate B post-impl
                # adversarial review. Mint adversarial_judge +
                # evidence_judge envelopes; gate auto_merge_runner
                # on review_verdict == "no_gaps". Pre-V5
                # auto_merge_runner fired unconditionally after
                # worker_drainer — implementations could merge
                # without independent review.
                #
                # Operator vision (Plan ARIA-V5 §1 verbatim):
                #   "ımplementerler ımplement ettıkten sonra da eksık
                #   varmı yanlıs varmı dıye agentlar yıne kontrol
                #   etmelı"
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="review_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={"plan_id": convergence_result.get("plan_id")},
                )
                review_result = review_runner(
                    cycle_id=cycle_id,
                    base_dir=root,
                    workspace_root=workspace_root,
                    plan_id=convergence_result.get("plan_id") or f"plan-{cycle_id}",
                    convergence_id=convergence_result.get("convergence_id")
                    or convergence_result.get("plan_id")
                    or f"plan-{cycle_id}",
                    impl_artifacts_ref=str(
                        worker_result.get("impl_artifacts_ref")
                        or f"cycle:{cycle_id}"
                    ),
                    worker_artifact_hash=str(
                        worker_result.get("worker_artifact_hash") or ""
                    ),
                    must_satisfy=[{
                        "id": "post-impl-no-gaps",
                        "description":
                            "Implementation satisfies the convergence-"
                            "stage must_satisfy contract; no gaps remain.",
                    }],
                    max_review_rounds=max_iterations_per_phase,
                )
                cycle_summary["review"] = review_result
                review_verdict = review_result.get("review_verdict", "gaps_open")
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="review_resolved",
                    status=str(review_verdict),
                    profile=profile_snapshot,
                    details={
                        "rounds_count":
                            review_result.get("rounds_count"),
                        "gaps_found_count": len(
                            review_result.get("gaps_found", [])
                        ),
                    },
                )

                # Plan ARIA-V3 §A1 — auto_merge_runner is REQUIRED.
                # Plan ARIA-V5 §2 V5.2 — auto_merge_runner is now
                # GATED by review_verdict == "no_gaps". Tier-1
                # source-substring invariant I-V5.2-04 asserts the
                # literal guard expression below MUST exist in this
                # module's source.
                if review_result["review_verdict"] == "no_gaps":
                    # NoOpAutoMergeRunner returns ``status="skipped"``,
                    # ``merges_completed=0`` for non-permitted profiles
                    # (observe / standard / frozen); RealAutoMergeRunner
                    # wraps ``merge_if_green`` for strict + autonomous.
                    auto_merge_result = auto_merge_runner(
                        base_dir=root,
                        workspace_root=workspace_root,
                    )
                else:
                    # Plan ARIA-V5 §2 V5.2 — review found gaps OR
                    # judges split OR review exhausted rounds.
                    # Block auto-merge for this cycle; surface the
                    # block reason on the cycle summary.
                    auto_merge_result = {
                        "schema_version": 1,
                        "status": "skipped",
                        "reason": f"review_{review_verdict}",
                        "merges_completed": 0,
                        "candidates_evaluated": 0,
                        "profile": profile_snapshot,
                    }
                    cycle_summary["auto_merge_blocked_by"] = (
                        f"review_{review_verdict}"
                    )
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="review_blocked_merge",
                        status=str(review_verdict),
                        profile=profile_snapshot,
                        details={
                            "gaps_found_count": len(
                                review_result.get("gaps_found", [])
                            ),
                        },
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

                # Plan ARIA-V3.3 §2b + V5.4 §3f — post-drain reflection
                # runs AFTER planner+bridge+convergence+worker+review+
                # auto_merge so the operator-facing daily report covers
                # the FULL cycle including Gate A + Gate B verdicts.
                # V3.3 closes F-010-D2-POSTMORTEM by relocating
                # reflection from cycle.py:397 to here; V5.4 bumps the
                # schema to v2 and injects the Gate A + Gate B + V5.3
                # pedagogy snapshots so the daily report's
                # ``## Convergence`` + ``## Pedagogy`` sections render
                # next to the existing Tool Health + Auto-Merge
                # sections. Direct CLI path (``aria-kernel cycle run``)
                # still runs reflection inline without these kwargs;
                # its v2 row carries convergence: null + pedagogy:
                # null to signal legitimately-skipped semantics.
                post_drain_reflection = run_reflection(
                    cycle_id=cycle_id,
                    base_dir=root,
                    repo_root=workspace_root,
                    convergence_result=convergence_result,
                    review_result=review_result,
                )
                cycle_summary["reflection"] = post_drain_reflection

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
