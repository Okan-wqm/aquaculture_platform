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
from typing import TYPE_CHECKING, Any, Callable, NamedTuple

from .autonomy_state import AutonomyStateReducer
from .file_lock import with_exclusive_lock
from .next_cycle_queue import mark_consumed, read_pending
from .reflection import run_reflection

if TYPE_CHECKING:
    # Plan ARIA-V3.1-0 — cycle_phases Protocol typing for the 5 new
    # phase concerns. Type-only imports preserve cold-start hermetic
    # discipline (I-V31-0-01); concrete NoOp variants are loaded
    # lazily inside the body when injection kwargs are None.
    from .cycle_phases import (
        CostTelemetryHook,
        MemoryHook,
        PlanContentProvider,
        ProfileGate,
        V9ImplementationRunner,
    )
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
    # Plan ARIA-V7 §2h v2 — SkillGenesisDrainer Protocol typed-only
    # import (V7.4 V6.2 convergent_skill_authoring producer).
    # REQUIRED kwarg; injects dispatcher_factory drafter/judge/sandbox
    # callables via internal CLI default-resolution (operator can
    # override via direct test injection).
    from .skill_genesis_drainer import SkillGenesisDrainer


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
    # A queue item is consumed only after its agent request is appended.
    import json

    from .agent_invocations import (
        create_agent_invocation_request,
        list_agent_invocation_requests,
    )
    from .tool_registry import append_tools_governance

    pending = read_pending(base_dir, limit=limit)
    consumed = 0
    for item in pending:
        qid = item.get("queue_item_id")
        if not isinstance(qid, str) or not qid:
            continue
        existing_request = _find_projected_queue_request(
            base_dir=base_dir, queue_item_id=qid,
            requests=list_agent_invocation_requests(base_dir=base_dir),
        )
        if existing_request is not None:
            mark_consumed(base_dir, queue_item_id=qid, consumed_by=daemon_agent_id)
            append_tools_governance(
                base_dir,
                "next_cycle_queue_item_projection_replayed",
                {
                    "queue_item_id": qid,
                    "request_id": existing_request.get("request_id"),
                },
            )
            consumed += 1
            continue
        prompt = {
            "$schema": "aria/next-cycle-queue-request/v1",
            "queue_item_id": qid,
            "source_cycle_id": item.get("source_cycle_id"),
            "pressure_id": item.get("pressure_id"),
            "recommended_action": item.get("recommended_action"),
            "candidate_tools": item.get("candidate_tools", []),
        }
        try:
            request = create_agent_invocation_request(
                target_agent="aria-autonomy-planner",
                role="maintenance_utility",
                suggested_prompt=json.dumps(prompt, indent=2, sort_keys=True),
                must_satisfy=[{
                    "id": "queue_item_projected",
                    "description": "Resolve the queued next-cycle item or produce a concrete blocked reason.",
                    "required": True,
                }],
                allowed_scope=["aria-kernel/**", "aria-tools/**", ".claude/**"],
                evidence_refs=[str(item.get("pressure_id") or qid)],
                pressure_event_id=str(item.get("pressure_id") or "") or None,
                base_dir=base_dir,
            )
        except Exception as exc:
            append_tools_governance(
                base_dir,
                "next_cycle_queue_projection_failed",
                {"queue_item_id": qid, "error": str(exc)},
            )
            continue
        mark_consumed(base_dir, queue_item_id=qid, consumed_by=daemon_agent_id)
        append_tools_governance(
            base_dir,
            "next_cycle_queue_item_projected",
            {"queue_item_id": qid, "request_id": request.get("request_id")},
        )
        consumed += 1
    return consumed



def _find_projected_queue_request(
    *,
    base_dir: Path,
    queue_item_id: str,
    requests: list[dict[str, Any]],
) -> dict[str, Any] | None:
    marker = f'"queue_item_id": "{queue_item_id}"'
    for request in reversed(requests):
        if request.get("role") != "maintenance_utility":
            continue
        if request.get("target_agent") != "aria-autonomy-planner":
            continue
        prompt = str(request.get("suggested_prompt") or "")
        if marker in prompt or queue_item_id in prompt:
            return request
    return None

# ORPHAN-HIGH-456 — kept next to the summary they bound, so a reviewer sees
# the cap and the marker list at the point the literal is built.
_MAX_INCOMPLETE_CYCLES_IN_SUMMARY = 20

# The cycle-level suppression/truncation markers `runtime_artifacts` sums.
# Mirrored from its `_SUPPRESSED_MARKER_KEYS` / `_TRUNCATED_MARKER_KEYS`; a
# producer that starts emitting one of these at cycle level is counted
# without further wiring, which was the stated intent of reading markers
# rather than incrementing locals.
_CYCLE_MARKER_KEYS: tuple[str, ...] = (
    "findings_suppressed",
    "suppressed_count",
    "prompt_truncated",
    "truncated_count",
)


def _bounded_cycle_summary(cycle_result: dict[str, Any]) -> dict[str, Any]:
    tool_runs = cycle_result.get("tool_run_summary") if isinstance(cycle_result.get("tool_run_summary"), list) else []
    artifact_refs = [
        ref for ref in cycle_result.get("artifact_refs", [])
        if isinstance(ref, dict)
    ] if isinstance(cycle_result.get("artifact_refs"), list) else []
    failed_phases = cycle_result.get("failed_phases")
    if not isinstance(failed_phases, list):
        failed_phases = [
            {"phase": str(item), "status": "failed"}
            for item in cycle_result.get("extended_phase_failures", [])
        ] if isinstance(cycle_result.get("extended_phase_failures"), list) else []
    summary = {
        "schema_version": 2,
        "cycle_id": cycle_result.get("cycle_id"),
        "status": cycle_result.get("status"),
        "runtime_status": cycle_result.get("runtime_status", "ok" if cycle_result.get("status") == "completed" else cycle_result.get("status")),
        "tool_run_summary": tool_runs,
        "artifact_refs": artifact_refs,
        "artifact_integrity": cycle_result.get("artifact_integrity"),
        "non_ok_tools": cycle_result.get("non_ok_tools", []),
        "failed_phases": failed_phases,
        "incomplete_lifecycle_count": cycle_result.get("incomplete_lifecycle_count", 0),
    }
    # ORPHAN-HIGH-456 — this literal is CLOSED, so any key it does not name
    # is deleted on the way to the publisher. Two consumers were reading
    # keys that could therefore never arrive:
    #
    #   * `runtime_artifacts` raises `cycle_lifecycle_unreadable` from
    #     `cycle.get("cycle_lifecycle")` — the distinction between "zero
    #     incomplete cycles" and "the cycles ledger could not be read",
    #     which is the whole point of ORPHAN-HIGH-424's fix. `cycle.py`
    #     produces the snapshot; this function dropped it one call later,
    #     so the warning was unreachable in production while its tests
    #     asserted on the raw cycle dict, a shape production never emits.
    #   * the suppression/truncation markers are summed at cycle level as
    #     well as per tool run, and no cycle-level marker could survive
    #     this literal either.
    #
    # `incomplete_cycles` is capped because it is operator-facing evidence,
    # not a data feed, and an unbounded list from a damaged ledger is how a
    # summary becomes unpublishable.
    lifecycle = cycle_result.get("cycle_lifecycle")
    if isinstance(lifecycle, dict):
        incomplete = lifecycle.get("incomplete_cycles")
        summary["cycle_lifecycle"] = {
            "valid": lifecycle.get("valid"),
            "incomplete_count": lifecycle.get("incomplete_count", 0),
            "incomplete_cycles": (
                list(incomplete)[:_MAX_INCOMPLETE_CYCLES_IN_SUMMARY]
                if isinstance(incomplete, list)
                else []
            ),
            "lifecycle_read_error": lifecycle.get("lifecycle_read_error"),
            "ledger_integrity_error": lifecycle.get("ledger_integrity_error"),
        }
    for marker in _CYCLE_MARKER_KEYS:
        if marker in cycle_result:
            summary[marker] = cycle_result[marker]
    return summary


class PreflightVerdict(NamedTuple):
    """RC-5 — a preflight outcome that can carry WHY without a positional tuple.

    ``detail`` exists because a refused policy is only actionable if the
    operator is told which key in which file is wrong. The reason code is for
    the state machine; the detail is for the human, carried verbatim from the
    GovernanceError rather than re-worded, so the message the operator reads is
    the message the code raised.
    """

    status: str
    reason: str | None = None
    detail: str | None = None


def _cycle_preflight(
    *,
    base_dir: Path,
    profile_snapshot: str,
) -> PreflightVerdict:
    """Plan ARIA-V3 §B2 — cost + failure + lease preflight.

    Returns ``PreflightVerdict("ok")`` when the cycle is permitted to proceed;
    ``PreflightVerdict("blocked", reason_code, detail)`` when refused.

    ORPHAN-CRITICAL-420 S2 — renamed from ``_autonomous_preflight``. The old
    name described the old behaviour: the whole body short-circuited OK unless
    profile was ``autonomous``, on the stated rationale that "strict/standard/
    observe/frozen have their own gates". They do not. `strict` holds pr_open
    authority and `standard` holds change_committed authority, and neither
    consulted the failure breaker anywhere — so a tripped breaker stopped
    nothing on the profile the scheduled lane actually runs.

    The checks now have three DIFFERENT scopes, which is why they can no
    longer share one profile test:

      * failure breaker — every profile in PROFILES_WITH_ACTION_AUTHORITY.
        It exists to stop the system from acting after repeated rejections,
        so it must cover everything that can act. observe/frozen are exempt
        by construction (they hold no authority), which also preserves the
        operator's ability to run a read-only diagnostic cycle while tripped.
      * cost breaker — autonomous only, unchanged. Cost accrues through the
        autonomous agent-invocation lane; extending it needs the B0 producer
        and window analysis that ORPHAN-HIGH-466 tracks, and widening the
        scope without that would gate profiles against a counter nothing
        currently increments.
      * host lease — autonomous only, unchanged, and correctly so: it is a
        cross-host mutual exclusion for the autonomous daemon. A standard
        operator-driven cycle has no daemon to race.

    Autonomous evaluation ORDER is preserved exactly (cost, failure, lease)
    so the reason code an autonomous run reports does not change.

    Reason codes (exit_reason values):
      * ``cost_breaker_tripped`` — B0 cost circuit breaker tripped
      * ``failure_breaker_tripped`` — B2 failure circuit breaker tripped
      * ``autonomous_host_lease_blocked`` — §2n cross-host lease held
        by a different host
      * ``policy_refused`` — RC-5. The genesis policy itself is invalid, so no
        breaker verdict can be computed. Named for the class rather than for
        one cause: ``circuit_breaker_policy`` refuses BOTH a renamed key
        (``threshold_24h``) and a ``failure_window_hours`` below the derived
        floor, and calling the reason ``policy_migration_required`` — as the
        plan specified — would mislabel the second as a migration when it is a
        range violation. The specific GovernanceError message is carried in
        ``detail`` and lands in the governance row, so nothing is lost by
        having one code.
    """
    is_autonomous = profile_snapshot == "autonomous"
    # Lazy imports — keep run_autonomy_orchestrator importable when
    # the new B2 modules are absent (e.g. cold downgrade scenarios).
    if is_autonomous:
        try:
            from .cost_budget import current_state as _cost_state
            if _cost_state(base_dir) == "tripped":
                return PreflightVerdict("blocked", "cost_breaker_tripped")
        except ImportError:
            pass
    # current_state() is safe to gate on: evaluate_breaker returns
    # BREAKER_STATE_TRIPPED for dropped/unreadable evidence as well as for a
    # genuine threshold breach, so damaged evidence blocks rather than reading
    # as "ok". Operators separate the two causes with `aria-kernel breaker
    # status`, which prints the verdict reason.
    from .runtime_profile import PROFILES_WITH_ACTION_AUTHORITY

    if profile_snapshot in PROFILES_WITH_ACTION_AUTHORITY:
        from .tool_registry import GovernanceError as _PolicyError

        try:
            from .circuit_breaker import current_state as _failure_state
            if _failure_state(base_dir) == "tripped":
                return PreflightVerdict("blocked", "failure_breaker_tripped")
        except ImportError:
            pass
        except _PolicyError as exc:
            # RC-5. This guard used to catch ImportError ONLY, while the call it
            # wraps reads the genesis policy: `current_state` -> evaluate_breaker
            # -> circuit_breaker_policy, which raises GovernanceError by design
            # when an override carries a renamed key. So an operator with an
            # untracked aria-config/genesis_policy.json got a traceback out of
            # run_autonomy_orchestrator, on a path whose whole purpose is to exit
            # cleanly with a reason code.
            #
            # RC-4 widened the trigger rather than leaving it latent: a
            # failure_window_hours below the derived floor now raises here too.
            # That is why the two land in one commit — shipping RC-4 alone would
            # have turned a documented misconfiguration into a crash.
            #
            # A misconfiguration is an operator-actionable BLOCKED cycle: not a
            # crash, and not a swallowed exception that runs the breaker on
            # defaults the operator never chose.
            return PreflightVerdict("blocked", "policy_refused", str(exc))
    if not is_autonomous:
        return PreflightVerdict("ok")
    try:
        from .autonomous_host_lease import acquire_lease
        from .tool_registry import GovernanceError as _GE
        try:
            acquire_lease(base_dir=base_dir)
        except _GE as exc:
            if "autonomous_host_lease_blocked" in str(exc):
                return PreflightVerdict("blocked", "autonomous_host_lease_blocked")
            raise
    except ImportError:
        pass
    return PreflightVerdict("ok")


def run_autonomy_orchestrator(
    *,
    base_dir: str | Path,
    auto_merge_runner: "AutoMergeRunner",
    github_adapter: Any,
    convergence_runner: "ConvergenceRunner",
    review_runner: "ReviewRunner",
    specialist_review_runner: "SpecialistReviewRunner",
    plan_synthesizer: "PlanSynthesizer",
    skill_genesis_drainer: "SkillGenesisDrainer",
    workspace_root: str | Path | None = None,
    cycle_deadline_seconds: float = 1800.0,
    challenger_timeout_seconds: float = 1800.0,
    max_cycles: int = DEFAULT_MAX_CYCLES,
    max_iterations_per_phase: int = DEFAULT_MAX_ITERATIONS_PER_PHASE,
    max_rounds: int = 4,
    daemon_id: str = DEFAULT_DAEMON_ID,
    aria_stop_filename: str = "ARIA_STOP",
    cycle_runner: Callable[..., dict[str, Any]] | None = None,
    planner_drainer: Callable[..., dict[str, Any]] | None = None,
    worker_drainer: Callable[..., dict[str, Any]] | None = None,
    bridge_drainer: Callable[..., dict[str, Any]] | None = None,
    # Plan ARIA-V3.1-0 — cycle_phases Protocol-based DI seam (5 hooks).
    # NoOp defaults preserve V3 baseline behavior; V3.1-A..E install
    # real implementations.  Callers stay binary-compatible — every
    # new kwarg is keyword-only optional with a None sentinel that
    # resolves to its NoOp variant inside the body (lazy-imported to
    # keep `import aria_kernel.autonomy_orchestrator` hermetic per
    # I-V31-0-05).
    plan_content_provider: "PlanContentProvider | None" = None,
    v9_implementation_runner: "V9ImplementationRunner | None" = None,
    memory_hook: "MemoryHook | None" = None,
    cost_telemetry_hook: "CostTelemetryHook | None" = None,
    profile_gate: "ProfileGate | None" = None,
    # Plan ARIA-V3.1-E — profile is REQUIRED (no default). Closes
    # H-9 caller migration + H-15 Tier-1 honesty. The orchestrator
    # body uses this kwarg as the SSoT; the legacy
    # `get_profile(base_dir=root)` call has been removed (I-V31-E-04).
    # CLI surface mints the value via argparse + records audit-trail
    # row via set_profile() when the operator overrides via flag
    # (closes C-2 SOC2 gap).
    profile: str,
    # Plan ARIA-V3.1-E + B-9 — distinct poll budget for the V9
    # implementation phase (HIGH-13). Default 1800s (30 min)
    # matches the CONVERGED-to-PR-merge wall-clock target. Distinct
    # from `challenger_timeout_seconds` (which gates the inner
    # convergence_drainer round-poll) — the V9 implementer pipeline
    # has its own wall-clock budget.
    implementer_poll_seconds: float = 1800.0,
    max_budget_usd_per_cycle: float = 3.00,
    # Runtime v2 hardening: artifact/lifecycle failures must stop the
    # autonomy loop by default after the cycle ledger has been closed.
    fail_closed_on_cycle_failure: bool = True,
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
    # Plan ARIA-V3.1-E — drop `get_profile` import; the orchestrator
    # body uses the explicit `profile` kwarg as SSoT.
    # `enforce_profile_for_action` still resolves the active profile
    # internally via runtime_profile.get_profile_with_diagnostic,
    # which is the correct boundary for action-level gating (it
    # captures the CLI override + audit row in the same read).
    from .runtime_profile import enforce_profile_for_action
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
    # Plan ARIA-V3.1-0 — lazy-resolve NoOp defaults for the 5 phase
    # hooks. Cold-start discipline: each `from .cycle_phases.X import
    # NoOp*` happens ONLY when the caller did not inject a concrete
    # runner, so a hermetic `import aria_kernel.autonomy_orchestrator`
    # never touches the phase modules' transitive dependencies
    # (closes I-V31-0-05).
    if plan_content_provider is None:
        from .cycle_phases.plan_source import NoOpPlanContentProvider
        plan_content_provider = NoOpPlanContentProvider()
    if v9_implementation_runner is None:
        from .cycle_phases.implementer import NoOpV9ImplementationRunner
        v9_implementation_runner = NoOpV9ImplementationRunner()
    if memory_hook is None:
        from .cycle_phases.memory import NoOpMemoryHook
        memory_hook = NoOpMemoryHook()
    if cost_telemetry_hook is None:
        from .cycle_phases.cost_telemetry import NoOpCostTelemetryHook
        cost_telemetry_hook = NoOpCostTelemetryHook()
    if profile_gate is None:
        from .cycle_phases.profile_gate import NoOpProfileGate
        profile_gate = NoOpProfileGate()

    root = ensure_tools_dir(base_dir)
    os.environ["MAX_BUDGET_USD_PER_CYCLE"] = str(max_budget_usd_per_cycle)
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
    # Plan ARIA-V3.1-E — explicit kwarg SSoT (closes I-V31-E-04).
    # Pre-V3.1-E the orchestrator body re-resolved via
    # `get_profile(base_dir=root)`, which let a CLI override that
    # bypassed `set_profile()` race the runtime read. V3.1-E
    # collapses the surface: the operator-supplied `profile` IS the
    # cycle's profile; the CLI is responsible for recording the
    # override via set_profile() BEFORE entering the orchestrator
    # so the runtime-profile-history.jsonl audit row exists.
    profile_snapshot = profile

    # Plan ARIA-V3.1-E (E4) — preflight gate.
    #
    # Profile-conditional behavior:
    #   * autonomous → fail-fast. verify_preflight checks branch
    #     protection + signing key + ALLOWED_BASH_COMMANDS + GH_TOKEN +
    #     IMMUTABLE_PATHS; any failure raises GovernanceError so the
    #     autonomy run never enters its cycle loop on a misconfigured
    #     host (closes ai-safety CRIT-004).
    #   * strict   → soft-warn. preflight runs; failures emit a
    #     `preflight_strict_warnings` governance event but the cycle
    #     proceeds. Operator-driven dry-run cycles should still run on
    #     hosts missing GH App config.
    #   * standard / observe / frozen → preflight skipped (the actions
    #     these profiles permit don't require the preflight surface).
    #
    # `bypass_profile_gate=True` ensures the governance event reaches
    # the audit ledger even under frozen/observe (which would
    # otherwise block tool_governance writes via Plan 026R §A.4
    # surface enforcement).
    if profile in ("autonomous", "strict"):
        try:
            from . import preflight as _preflight_mod
            # skip_remote=True under autonomous when GH_TOKEN unset
            # would defeat the autonomous gate (the gh api call IS
            # the verification surface). Under strict, skip_remote
            # honors the token-presence signal so operator dry-runs
            # do not require GitHub auth.
            _skip_remote = (
                profile == "strict"
                and not bool(os.environ.get("GH_TOKEN"))
            )
            verdict = _preflight_mod.verify_preflight(
                profile=profile,
                workspace_root=str(workspace_root) if workspace_root else str(root),
                skip_remote=_skip_remote,
            )
        except ImportError:
            # `preflight` module absent — strict can proceed (no-op),
            # autonomous must fail-fast (defense-in-depth: a kernel
            # missing preflight cannot be the autonomous-mode host).
            verdict = None
            if profile == "autonomous":
                append_tools_governance(
                    root, "autonomy_orchestrator_refused",
                    {
                        "reason": "autonomous_profile_preconditions_not_met",
                        "failure_classes": ["preflight_module_unavailable"],
                        "reasons": ["preflight module not importable"],
                    },
                    bypass_profile_gate=True,
                )
                raise GovernanceError(
                    "autonomous_profile_preconditions_not_met: "
                    "preflight module not importable"
                )
        if verdict is not None and not getattr(verdict, "valid", True):
            failure_classes = tuple(getattr(verdict, "failure_classes", ()) or ())
            reasons = tuple(getattr(verdict, "reasons", ()) or ())
            if profile == "autonomous":
                append_tools_governance(
                    root, "autonomy_orchestrator_refused",
                    {
                        "reason": "autonomous_profile_preconditions_not_met",
                        "failure_classes": list(failure_classes),
                        "reasons": list(reasons),
                    },
                    bypass_profile_gate=True,
                )
                raise GovernanceError(
                    "autonomous_profile_preconditions_not_met: "
                    + "; ".join(reasons)
                )
            # strict — soft-warn.
            append_tools_governance(
                root, "preflight_strict_warnings",
                {
                    "failure_classes": list(failure_classes),
                    "reasons": list(reasons),
                },
                bypass_profile_gate=True,
            )

    try:
        with with_exclusive_lock(
            daemon_pid_path,
            timeout_seconds=_DAEMON_LOCK_TIMEOUT_SECONDS,
        ):
            # Plan 026R §F.1 + §A.4 — under frozen profile,
            # `append_tools_governance` is itself blocked (it routes
            # through `enforce_profile_for_write('tool_governance')`).
            # Emitting the orchestrator-started governance announce
            # only under a permitting profile keeps the frozen-bypass
            # invariant intact; frozen exits return `profile_frozen`
            # without appending governed state.
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
                        "max_budget_usd_per_cycle": max_budget_usd_per_cycle,
                        "started_at": _iso_now(),
                        "profile": profile_snapshot,
                    },
                )

            # Plan ARIA-V3.1-B3 — orphan-implementation-request reaper
            # (closes 6-validator H-12). Crash paths in a prior
            # orchestrator process or aria-implementer that bypass
            # try/finally cleanup leave plans stuck in
            # IMPLEMENTATION_REQUESTED OR IMPLEMENTATION_IN_FLIGHT.
            # The next orchestrator startup enumerates them via
            # scan_orphan_implementation_requests + transitions each
            # to IMPLEMENTATION_REJECTED with the canonical
            # `orchestrator_restart_reaped_orphan` rejection_class.
            # Per-orphan + summary governance events surface the
            # reaping in the audit trail.
            #
            # bypass_profile_gate=True on the summary event ensures
            # the reaper's audit row reaches the ledger even under
            # frozen/observe profiles (the reaping itself goes
            # through record_implementation_rejected which respects
            # profile gating). When no orphans are found the
            # summary event is suppressed (zero-noise floor).
            if profile_announce_allowed:
                try:
                    from .plan_convergence import (
                        scan_orphan_implementation_requests,
                        record_implementation_rejected,
                    )
                    _orphans = scan_orphan_implementation_requests(base_dir=root)
                except (ImportError, Exception) as _orphan_scan_exc:
                    _orphans = []
                    append_tools_governance(
                        root, "implementation_orphan_scan_failed",
                        {
                            "error_class": type(_orphan_scan_exc).__name__,
                            "error_message": str(_orphan_scan_exc)[:500],
                        },
                        bypass_profile_gate=True,
                    )
                _reaped: list[dict[str, Any]] = []
                for _orphan in _orphans:
                    _orphan_plan_id = _orphan.get("plan_id")
                    if not isinstance(_orphan_plan_id, str) or not _orphan_plan_id:
                        continue
                    try:
                        record_implementation_rejected(
                            plan_id=_orphan_plan_id,
                            rejection_class="orchestrator_restart_reaped_orphan",
                            rejected_at=_iso_now(),
                            base_dir=root,
                        )
                        _reaped.append(_orphan)
                        append_tools_governance(
                            root, "implementation_orphan_reaped",
                            {
                                "plan_id": _orphan_plan_id,
                                "prior_state": _orphan.get("state"),
                                "last_event_at": _orphan.get("last_event_at"),
                            },
                            bypass_profile_gate=True,
                        )
                    except Exception as _reap_exc:
                        # Best-effort — surface the failure but do not
                        # abort orchestrator startup over a single
                        # un-reapable orphan.
                        append_tools_governance(
                            root, "implementation_orphan_reap_failed",
                            {
                                "plan_id": _orphan_plan_id,
                                "error_class": type(_reap_exc).__name__,
                                "error_message": str(_reap_exc)[:500],
                            },
                            bypass_profile_gate=True,
                        )
                if _reaped:
                    append_tools_governance(
                        root, "implementation_orphans_reaped_summary",
                        {
                            "reaped_count": len(_reaped),
                            "scanned_count": len(_orphans),
                        },
                        bypass_profile_gate=True,
                    )

            for cycle_n in range(max_cycles):
                # Plan ARIA-V7 §3 V7.7 — per-cycle watchdog.
                # ``_cycle_started_at`` captures monotonic time at
                # cycle entry; the deadline check at the end of each
                # cycle compares against ``cycle_deadline_seconds``.
                # Hard-bound by I-V7.7-04 source-substring invariant.
                _cycle_started_at = time.monotonic()
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
                    exit_reason = "profile_frozen"
                    break

                # Plan ARIA-V3 §B2 + ORPHAN-CRITICAL-420 S2 — cycle preflight
                # gate. The FAILURE breaker fires for every profile holding
                # governed action authority (standard/strict/autonomous), not
                # just autonomous; cost + host-lease remain autonomous-scoped.
                # Checks, in priority order:
                #   1. cost_budget (B0) — $cost overrun          [autonomous]
                #   2. circuit_breaker (B2) — failure overrun    [any actor]
                #   3. autonomous_host_lease (§2n) — cross-host  [autonomous]
                # On any breaker tripped, exit cleanly with the matching
                # reason code (no error, no retry storm).
                preflight_status, preflight_reason, preflight_detail = _cycle_preflight(
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
                            # RC-5 — the operator-actionable half. Absent for the
                            # breaker/lease reasons, which are self-describing;
                            # present for policy_refused, where the reason code
                            # alone would not say which key in which file.
                            "preflight_detail": preflight_detail,
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
                    cycle_summary["cycle"] = _bounded_cycle_summary(cycle_result)
                    raw_status = str(cycle_result.get("runtime_status") or cycle_result.get("status") or "failed")
                    cycle_status = "ok" if raw_status in {"ok", "completed"} and not cycle_result.get("non_ok_tools") else "failed"
                except Exception as exc:
                    # ORPHAN-HIGH-456 — the lifecycle counter is dropped here
                    # precisely when it matters most: a cycle that crashed is
                    # the one likely to have left a started-without-terminal
                    # row behind. It cannot be read from `cycle_result` (there
                    # is none), so the summary says so explicitly rather than
                    # reporting a zero that reads as "nothing incomplete".
                    cycle_summary["cycle"] = {
                        "schema_version": 2,
                        "cycle_id": cycle_id,
                        "status": "failed",
                        "runtime_status": "failed",
                        "error": str(exc),
                        "cycle_lifecycle": {
                            "valid": False,
                            "incomplete_count": 0,
                            "incomplete_cycles": [],
                            "lifecycle_read_error": (
                                f"cycle raised before producing a lifecycle "
                                f"snapshot: {type(exc).__name__}"
                            ),
                        },
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
                elif fail_closed_on_cycle_failure:
                    per_cycle_results.append(cycle_summary)
                    exit_reason = "cycle_failed"
                    break

                # Plan ARIA-V10.4 Phase 1 instrumentation — cost-attribution
                # sentinel. V10.3-B endurance showed cycle 1 challenger
                # burned $0.39 + 99s + 3 turns on real Claude but
                # read_cost_attribution() returned 0 rows. The cost row
                # write path is silently broken (suspect: bypassed when
                # cycle convergence_blocks vs converges). Emit a sentinel
                # governance event when a cycle completes without any
                # cost row landing in this month's shard. Tier-3
                # detectable. Real fix lands in Phase 3 once root cause
                # known.
                try:
                    from .budget import _cost_attribution_shard as _cas
                    _shard = _cas(root)
                    _had_cost_row = False
                    if _shard.exists():
                        _shard_text = _shard.read_text(encoding="utf-8")
                        # Cheap substring match: cycle_id is unique to
                        # this cycle so its presence implies at least
                        # one cost row was written for this cycle.
                        _had_cost_row = cycle_id in _shard_text
                    if not _had_cost_row:
                        append_tools_governance(
                            root,
                            "cost_attribution_missing",
                            {
                                "cycle_id": cycle_id,
                                "cycle_status": cycle_status,
                                "shard_path": str(_shard),
                                "shard_exists": _shard.exists(),
                            },
                        )
                except Exception:
                    pass

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
                bridge_status = str(bridge_result.get("status") or "ok")
                pending_after = int(bridge_result.get("pending_after") or 0)
                if profile_snapshot in {"strict", "autonomous"} and (
                    bridge_status in {"skipped", "unknown", "failed"}
                    or pending_after > 0
                ):
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="bridge_replay_required",
                        status="failed",
                        profile=profile_snapshot,
                        details={
                            "bridge_status": bridge_status,
                            "pending_after": pending_after,
                        },
                    )
                    cycle_summary["failed_phases"] = list(cycle_summary.get("failed_phases", [])) + [
                        {
                            "phase": "bridge",
                            "status": "failed",
                            "bridge_status": bridge_status,
                            "pending_after": pending_after,
                        },
                    ]
                    per_cycle_results.append(cycle_summary)
                    exit_reason = "bridge_replay_required"
                    break

                # Plan ARIA-V7 §2h v2 Phase 7.4 — skill_genesis_drainer.
                # Polls skill-genesis/requests.jsonl for convergent=True
                # rows + dispatches each via run_convergent_authoring
                # (V6.2 surface that was DEAD CODE pre-V7). Status
                # update via derived-state ledger (request-status.jsonl);
                # crash-catch persists status=authoring_error BEFORE
                # re-raise; per-cycle token budget cap. Fires here
                # (AFTER bridge_drained, BEFORE plan_synthesizer +
                # Gate A) so authoring on cycle N can feed cycle N+1's
                # convergence target.
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="skill_genesis_drainer_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={"plan_id": f"plan-{cycle_id}"},
                )
                # Plan ARIA-V7 §2g v2 — dispatcher_factory provides
                # the 5 callables run_convergent_authoring expects.
                # Production defaults mint envelopes + poll for
                # consumer (ci_executor); tests injecting custom
                # skill_genesis_drainer can bypass these factories
                # entirely.
                from .dispatcher_factory import (
                    select_drafter as _v7_select_drafter,
                    select_judge as _v7_select_judge,
                    select_sandbox_runner as _v7_select_sandbox_runner,
                )
                _v7_genesis_result = skill_genesis_drainer(
                    cycle_id=cycle_id,
                    base_dir=root,
                    workspace_root=Path(workspace_root) if workspace_root else root,
                    profile=str(profile_snapshot or "standard"),
                    primary_drafter=_v7_select_drafter(role="primary_authoring"),
                    challenger_drafter=_v7_select_drafter(role="challenger_authoring"),
                    evidence_judge=_v7_select_judge(role="evidence_judgment"),
                    adversarial_judge=_v7_select_judge(role="adversarial_judgment"),
                    sandbox_runner=_v7_select_sandbox_runner(),
                )
                cycle_summary["skill_genesis"] = _v7_genesis_result
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="skill_genesis_drainer_resolved",
                    status=str(_v7_genesis_result.get("aggregate_verdict") or "ok"),
                    profile=profile_snapshot,
                    details={
                        "requests_scanned": _v7_genesis_result.get("requests_scanned"),
                        "requests_dispatched": _v7_genesis_result.get("requests_dispatched"),
                        "tokens_spent_this_cycle": _v7_genesis_result.get("tokens_spent_this_cycle"),
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
                #
                # Plan ARIA-V3.1-A — plan_content_provider Protocol
                # gets first call. The V9PressureSourceProvider iterates
                # the 5-source ranked candidate list AND falls through
                # to V7 git_diff internally; the NoOp variant returns
                # None and the orchestrator continues to the legacy
                # plan_synthesizer kwarg (V8 backward compat for tests
                # that haven't installed a Protocol).
                #
                # The envelope's `content` field IS the plan_content
                # dict the legacy code path expected; the `metadata`
                # field carries `_pressure_source_type` for downstream
                # cost-attribution (V3.1-D consumes via
                # cost_telemetry_hook).
                _v7_plan_envelope = plan_content_provider.synthesize(
                    cycle_id=cycle_id,
                    workspace_root=Path(workspace_root) if workspace_root else root,
                    base_dir=root,
                    profile=profile,
                )
                _v7_plan_content: dict[str, Any] | None
                _v7_pressure_source_type: str
                if _v7_plan_envelope is not None:
                    _v7_plan_content = _v7_plan_envelope.content
                    _v7_pressure_source_type = str(
                        _v7_plan_envelope.metadata.get(
                            "_pressure_source_type", "git_diff",
                        )
                    )
                else:
                    # Plan ARIA-V3.1-A — Protocol returned None
                    # (NoOp default OR V9 provider with empty results).
                    # Fall through to the legacy plan_synthesizer kwarg
                    # (V8 backward compat path; tests don't install a
                    # Protocol).
                    _v7_plan_content = plan_synthesizer(
                        cycle_id=cycle_id,
                        workspace_root=Path(workspace_root) if workspace_root else root,
                        base_dir=root,
                    )
                    _v7_pressure_source_type = "git_diff"
                # Surface the resolved pressure source on the cycle
                # summary so V10.4 cost-attribution rollup attributes
                # correctly even when the legacy fallback path fired.
                cycle_summary["_pressure_source_type"] = _v7_pressure_source_type
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
                # Plan ARIA-V7 §2g v2 Phase 7.2 — try/except envelope.
                # Even with V7.1's plan_synthesizer producing real
                # plan_content, downstream malformed-payload edge
                # cases (operator-supplied debug payload, drifted
                # schema, unexpected mutation in convergence_drainer)
                # can still raise GovernanceError from
                # plan_convergence._validate_plan_content. Without
                # this try/except, the cycle CRASHES and the autonomy
                # loop dies (ORPHAN-HIGH-079). The try/except converts
                # the crash into a verdict (convergence_invalid_plan)
                # + governance event capturing the raw plan_content
                # for forensics. Source-substring invariant I-V7.2-04
                # pins the literal try/except envelope.
                # Plan ARIA-V7 §2i v2 BUGFIX — caller passes
                # plan_synthesizer's REAL fields to convergence_runner
                # (was passing 1-element stubs that the agent
                # correctly refused as "underspecified envelope").
                # The plan_synthesizer producer mints valid 7-field
                # plan_content; the caller MUST forward those fields
                # into the convergence envelope so the agent receives
                # the actual work surface (evidence_refs +
                # allowed_scope from synthesized plan; must_satisfy
                # derived from key_changes clusters).
                _v7_must_satisfy = [
                    {
                        "id": str(kc.get("id", f"key-change-{i}")),
                        "description": str(kc.get("description", "")),
                    }
                    for i, kc in enumerate(_v7_plan_content.get("key_changes") or [])
                ] or [{
                    "id": "cycle-impl-satisfies-scope",
                    "description":
                        "Implementation must satisfy the cycle's "
                        "must_satisfy contract derived from "
                        "discovery + planner output.",
                }]
                _v7_evidence_refs = list(
                    _v7_plan_content.get("evidence_refs") or [f"cycle:{cycle_id}"]
                )
                _v7_allowed_scope = list(
                    _v7_plan_content.get("affected_surfaces") or [f"cycle/{cycle_id}"]
                ) or [f"cycle/{cycle_id}"]
                try:
                    # Plan ORPHAN-HIGH-082 fix: convergence_runner kwargs are
                    # now sourced from the orchestrator's own parameters
                    # rather than from max_iterations_per_phase (different
                    # concept — daemon dispatch iteration bound). This
                    # closes the CLI → orchestrator → drainer plumbing
                    # gap where --challenger-timeout-seconds and
                    # --max-rounds were parsed by argparse + validated
                    # but never reached the drainer; drainer used its
                    # 1800s + 4-rounds defaults regardless of CLI input.
                    convergence_result = convergence_runner(
                        cycle_id=cycle_id,
                        base_dir=root,
                        workspace_root=workspace_root,
                        plan_id=f"plan-{cycle_id}",
                        plan_seed=_v7_plan_content,
                        must_satisfy=_v7_must_satisfy,
                        evidence_refs=_v7_evidence_refs,
                        allowed_scope=_v7_allowed_scope,
                        max_rounds=max_rounds,
                        challenger_timeout_seconds=challenger_timeout_seconds,
                    )
                except GovernanceError as _v7_exc:
                    # Plan ARIA-V7 §2g v2 — invalid plan_content surface.
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="convergence_invalid_plan",
                        status="governance_error",
                        profile=profile_snapshot,
                        details={
                            "plan_id": f"plan-{cycle_id}",
                            "error_class": type(_v7_exc).__name__,
                            "error_message": str(_v7_exc)[:1000],
                            "plan_content_keys": sorted(
                                (_v7_plan_content or {}).keys()
                            ),
                        },
                    )
                    append_tools_governance(
                        root,
                        "convergence_invalid_plan",
                        {
                            "cycle_id": cycle_id,
                            "plan_id": f"plan-{cycle_id}",
                            "error_class": type(_v7_exc).__name__,
                            "error_message": str(_v7_exc)[:2000],
                            "plan_content_keys": sorted(
                                (_v7_plan_content or {}).keys()
                            ),
                        },
                    )
                    cycle_summary["convergence_invalid_plan"] = {
                        "error_class": type(_v7_exc).__name__,
                        "error_message": str(_v7_exc)[:1000],
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

                # Plan ARIA-V3.1-C2 — post-CONVERGED MemoryHook wire.
                # Fires the bounded governance read → stability check
                # → record_convention → verify_chain_or_quarantine →
                # skill_genesis_human_required_dispatch pipeline.
                # NoOp variant (default) preserves V8 behavior; the
                # MemoryHookImpl production variant activates the V10
                # memory pillar per cycle (closes V31-C2 follow-up).
                #
                # Placed BEFORE specialist_review_started so the V10
                # memory contribution lands per CONVERGED cycle even
                # when specialist_review rejects. The MemoryHook is
                # idempotent for crash recovery — the convention row
                # is keyed by pattern_signature.
                try:
                    _v31c2_memory_result = memory_hook.record(
                        cycle_id=cycle_id,
                        plan_id=convergence_result.get("plan_id") or f"plan-{cycle_id}",
                        workspace_root=Path(workspace_root) if workspace_root else root,
                        base_dir=root,
                        converged_plan=convergence_result.get("converged_plan", {}) or {},
                        plan_envelope_metadata={
                            "_pressure_source_type": cycle_summary.get(
                                "_pressure_source_type", "git_diff",
                            ),
                        },
                        profile=str(profile_snapshot or "standard"),
                        signer_key_fp=None,  # V31-D2 will thread the cycle key fp here
                    )
                    cycle_summary["memory_hook"] = _v31c2_memory_result
                    AutonomyStateReducer.transition(
                        root, cycle_id=cycle_id,
                        phase="memory_hook_recorded",
                        status=str(_v31c2_memory_result.get("status") or "ok"),
                        profile=profile_snapshot,
                        details={
                            "convention_recorded": _v31c2_memory_result.get("convention_recorded"),
                            "stability_fired": _v31c2_memory_result.get(
                                "stability_result", {},
                            ).get("stable"),
                            "skill_genesis_dispatched": _v31c2_memory_result.get(
                                "skill_genesis_dispatched",
                            ),
                        },
                    )
                except Exception as _v31c2_exc:
                    # Best-effort — V10 memory pillar failure must not
                    # block specialist_review + worker_drainer +
                    # auto_merge. The exception is surfaced via
                    # governance event for operator visibility.
                    append_tools_governance(
                        root, "memory_hook_failed",
                        {
                            "cycle_id": cycle_id,
                            "error_class": type(_v31c2_exc).__name__,
                            "error_message": str(_v31c2_exc)[:500],
                        },
                        bypass_profile_gate=True,
                    )

                # Plan ARIA-V10.5 Phase 7 — F-027 closure. V9
                # implementation phase. Per cycle_phases/implementer.py
                # contract: "V9 closes the value gap CONVERGED plans
                # never become real code. v3.1-B wires the
                # implementation phase between CONVERGED and
                # specialist_review." Pre-F-027 the runner was plumbed
                # via the v9_implementation_runner parameter (defaulted
                # to NoOpV9ImplementationRunner at line 368-370) but
                # .run() was never invoked — F-024+F-025+F-026 trinity
                # delivered CONVERGED cycles in production
                # (v10-5-f-026-validation cycle 3 at 21:24:46) but the
                # downstream pipeline was structurally absent.
                #
                # The signal-typed V9ImplementationResult lets the
                # orchestrator pick the next specialist_review behavior
                # without inspecting terminal_state heuristically.
                # NoOp/Strict variants return IMPLEMENTATION_REQUEST_REFUSED
                # with specialist_review_signal=review_converged_plan so
                # V8 behavior is preserved by default. Autonomous variant
                # mints the aria-implementer subprocess + polls + records
                # outcome.
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="v9_implementation_phase_started",
                    status="ok",
                    profile=profile_snapshot,
                    details={
                        "plan_id": convergence_result.get("plan_id"),
                        "runner_class": type(v9_implementation_runner).__name__,
                    },
                )
                try:
                    v9_result = v9_implementation_runner.run(
                        cycle_id=cycle_id,
                        plan_id=str(
                            convergence_result.get("plan_id") or f"plan-{cycle_id}"
                        ),
                        workspace_root=Path(workspace_root) if workspace_root else root,
                        base_dir=root,
                        converged_plan=convergence_result.get("converged_plan", {}) or {},
                        cross_review_summary={
                            "revision_id": convergence_result.get("convergence_id")
                            or convergence_result.get("plan_id"),
                            "rounds_count": convergence_result.get("rounds_count"),
                            "request_ids": convergence_result.get("request_ids", []),
                        },
                        profile=str(profile_snapshot or "standard"),
                        implementer_poll_seconds=implementer_poll_seconds,
                    )
                    cycle_summary["v9_implementation"] = {
                        "terminal_state": v9_result.terminal_state,
                        "pr_url": v9_result.pr_url,
                        "rejection_class": v9_result.rejection_class,
                        "specialist_review_signal": v9_result.specialist_review_signal,
                    }
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="v9_implementation_phase_resolved",
                        status=str(v9_result.terminal_state),
                        profile=profile_snapshot,
                        details={
                            "specialist_review_signal": v9_result.specialist_review_signal,
                            "pr_url": v9_result.pr_url,
                            "rejection_class": v9_result.rejection_class,
                        },
                    )
                except Exception as _v9_exc:
                    # Best-effort: a V9 phase failure must not block
                    # specialist_review + worker_drainer. The failure
                    # surfaces via governance event for operator
                    # visibility, and the orchestrator falls back to
                    # review_converged_plan signal (the V8 default).
                    append_tools_governance(
                        root, "v9_implementation_phase_failed",
                        {
                            "cycle_id": cycle_id,
                            "plan_id": convergence_result.get("plan_id"),
                            "error_class": type(_v9_exc).__name__,
                            "error_message": str(_v9_exc)[:500],
                        },
                        bypass_profile_gate=True,
                    )
                    cycle_summary["v9_implementation"] = {
                        "terminal_state": "IMPLEMENTATION_REQUEST_REFUSED",
                        "pr_url": None,
                        "rejection_class": f"runner_exception:{type(_v9_exc).__name__}",
                        "specialist_review_signal": "review_converged_plan",
                    }

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
                # Profile gating (ORPHAN-HIGH-423 revision):
                #   * observe → never dispatch Tier-1; defensive
                #   * standard / strict / autonomous →
                #       specialists_unavailable BLOCKS (fail-closed)
                #
                # Pre-fix only `strict` blocked, so `standard` and
                # `autonomous` proceeded on an unreviewed domain. That put
                # the WEAKEST specialist gate on the profile holding real
                # merge authority — an inversion, not a trade-off. A
                # selected specialist that did not deliver means its domain
                # went unreviewed, which is not a degraded pass.
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

                # ORPHAN-HIGH-423 — the policy lives in
                # specialist_review_runner.specialist_verdict_blocks_cycle
                # so it is testable without asserting on this function's
                # source. Every write-capable profile now fails closed on
                # an unsatisfiable gate.
                from .specialist_review_runner import specialist_verdict_blocks_cycle

                _blocks_cycle = specialist_verdict_blocks_cycle(
                    verdict=str(specialist_verdict),
                    profile=str(profile_snapshot),
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

                # Plan ARIA-V7 §3 Phase 7.6 — calibration_reporter
                # invokes generate_adapter_calibration_report for
                # every SHADOW/ACTIVE adapter; persists precision_
                # history to aria-tools/calibration/adapter-
                # calibration-reports.jsonl. Without this V6.4
                # compute_auto_promote_token can NEVER fire (V6.4
                # was a latent dead loop pre-V7). Pinned by I-V7.6-04
                # source-substring invariant. Phase fires AFTER
                # auto_merge_runner and BEFORE reflection so V6.4
                # observes the freshest calibration.
                from .adapter_calibration import (
                    generate_adapter_calibration_report,
                )
                from .tool_registry import list_tools as _v7_list_tools
                _v7_calibration_tool_ids = [
                    t.get("tool_id")
                    for t in _v7_list_tools(base_dir=root)
                    if t.get("kind") == "adapter"
                    and t.get("status") in ("SHADOW", "ACTIVE")
                    and t.get("tool_id")
                ]
                if _v7_calibration_tool_ids:
                    try:
                        calibration_result = generate_adapter_calibration_report(
                            tool_ids=_v7_calibration_tool_ids,
                            base_dir=root,
                            cycle_id=cycle_id,
                        )
                        cycle_summary["calibration_reporter"] = calibration_result
                    except Exception as _v7_calib_exc:
                        # Surface failure without crashing the cycle.
                        cycle_summary["calibration_reporter"] = {
                            "status": "error",
                            "error_class": type(_v7_calib_exc).__name__,
                            "error_message": str(_v7_calib_exc)[:500],
                        }
                else:
                    cycle_summary["calibration_reporter"] = {
                        "status": "no_adapters",
                        "tool_ids": [],
                    }
                AutonomyStateReducer.transition(
                    root,
                    cycle_id=cycle_id,
                    phase="calibration_reporter_completed",
                    status=str(cycle_summary["calibration_reporter"].get("status") or "ok"),
                    profile=profile_snapshot,
                    details={
                        "tool_ids_scanned": len(_v7_calibration_tool_ids),
                    },
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

                # Plan ARIA-V7 §3 V7.7 — cycle watchdog. If wall-clock
                # since cycle_started exceeded cycle_deadline_seconds,
                # emit cycle_deadline_exceeded phase + write ARIA_STOP
                # to halt the autonomy loop cleanly. No silent hang.
                # Pinned by I-V7.7-04 source-substring invariant.
                _deadline_hit = (time.monotonic() - _cycle_started_at) >= cycle_deadline_seconds
                if _deadline_hit:
                    AutonomyStateReducer.transition(
                        root,
                        cycle_id=cycle_id,
                        phase="cycle_deadline_exceeded",
                        status="deadline_hit",
                        profile=profile_snapshot,
                        details={
                            "cycle_deadline_seconds": cycle_deadline_seconds,
                            "elapsed_seconds": (
                                time.monotonic() - _cycle_started_at
                            ),
                        },
                    )
                    try:
                        aria_stop_path.parent.mkdir(parents=True, exist_ok=True)
                        aria_stop_path.write_text(
                            "cycle_deadline_exceeded", encoding="utf-8",
                        )
                    except OSError:
                        pass

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
                "exits_clean": exit_reason not in {"cycle_failed"},
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
