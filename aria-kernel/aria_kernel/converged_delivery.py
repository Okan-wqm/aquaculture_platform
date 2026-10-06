"""ARIA-HIGH-362 — a CONVERGED plan is offered to the V9 runner until it leaves CONVERGED.

WHY. ``CONVERGED`` is terminal for convergence (``plan_convergence.TERMINAL_STATES``),
so neither ``list_active_plans`` nor ``resume_candidate_plan_id`` ever looks at a
converged plan again. The V9 implementation runner was called in exactly one
place: the cycle whose drainer returned ``converged``. Whatever that one call
produced was final. Under ``standard`` it is the NoOp's refusal; under
``strict`` a dirty workspace, a plan without an architectural tier or an
unregistered recipe makes staging raise (``implementation_staging_governance_
error``), and any other fault becomes ``runner_exception:<class>``. Each of
those left the plan CONVERGED for good, with one governance row that nothing
reads. A plan the whole P+C+CR debate agreed on was delivered at most once,
and only if the night it converged happened to be a night that could deliver.

WHAT. One function offers a converged plan to the runner,
:func:`deliver_converged_plan`, and both callers use it: the converging cycle
(origin ``converged_this_cycle``) and a sweep at the start of every later
cycle (:func:`redeliver_stranded_converged_plans`, origin
``stranded_redelivery``). An offer under a profile that holds implementation
authority (``pr_create`` in ``runtime_profile.ACTION_PERMISSIONS``, the same
cell ``select_v9_implementation_runner`` reads) first records
``implementation_delivery_attempted`` on the plan's own ledger, so the count is
durable, idempotent per (plan, attempt) and survives a process that dies inside
the runner. A plan is not offered while an implementation request for it is
live, after it left CONVERGED, or twice in one cycle. After
``MAX_DELIVERY_ATTEMPTS`` counted offers that left it CONVERGED, the plan is
escalated: an operator record in ``human-required/`` (the surface the daily
report and ``aria-kernel human-required list`` show) and the plan's own
``HUMAN_REQUIRED`` terminal with reason code ``implementation_delivery_exhausted``.

An offer under a profile WITHOUT that authority is not counted. The NoOp's
refusal says nothing about the plan — it says the night could not deliver —
so a ``standard`` lane neither spends a plan's attempts nor escalates it; the
sweep reports it as ``no_implementation_authority`` and the first night that
can deliver gets the full bound.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

# Three offers by a lane that could deliver. One refusal can be the weather
# (a dirty checkout, a red baseline); three in a row on three cycles is the
# plan, and a person has to look at it.
MAX_DELIVERY_ATTEMPTS: int = 3
# Staging runs the plan's validation suite as its baseline, so one re-offer
# per cycle keeps a backlog of stranded plans from turning one cycle into N
# baseline runs. Escalations are not bounded: they run no suite.
REDELIVERIES_PER_CYCLE: int = 1
DELIVERY_EXHAUSTED_REASON: str = "implementation_delivery_exhausted"
HUMAN_REQUIRED_CONTEXT_KIND: str = "converged_plan_delivery"
ORIGIN_CONVERGED: str = "converged_this_cycle"
ORIGIN_REDELIVERY: str = "stranded_redelivery"

# Why an offer was not made. Named so the cycle summary and the tests read the
# same strings.
WITHHELD_NOT_CONVERGED: str = "not_converged"
WITHHELD_REQUEST_LIVE: str = "implementation_request_live"
WITHHELD_OFFERED_THIS_CYCLE: str = "offered_this_cycle"
WITHHELD_EXHAUSTED: str = "attempts_exhausted"
WITHHELD_ATTEMPT_TAKEN: str = "attempt_claimed_elsewhere"
WITHHELD_ATTEMPT_UNRECORDED: str = "attempt_unrecorded"
WITHHELD_NO_AUTHORITY: str = "no_implementation_authority"
WITHHELD_CYCLE_BOUND: str = "per_cycle_bound"


def holds_implementation_authority(profile: str) -> bool:
    """True when ``profile`` may finish an implementation (``pr_create``)."""
    from . import runtime_profile
    from .cycle_phases.implementer import IMPLEMENTATION_ACTION_KIND

    return profile in runtime_profile.ACTION_PERMISSIONS[IMPLEMENTATION_ACTION_KIND]


def human_required_request_id(plan_id: str) -> str:
    return f"converged-delivery-exhausted-{plan_id}"


def live_implementation_request_ids(plan_id: str, *, base_dir: Path) -> list[str]:
    """Implementation requests for ``plan_id`` whose derived state is not terminal.

    The envelope mint appends the request row BEFORE it writes the plan's
    ``implementation_requested`` event, so a process that dies between the
    two leaves a live request on a plan that still folds to CONVERGED. Offering
    that plan again would mint a second envelope for work already queued.
    """
    from .agent_invocations import derive_request_state, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES
    from .cross_review_bridge import IMPLEMENTATION_ROLE

    live: list[str] = []
    for row in list_agent_invocation_requests(
        base_dir=base_dir, convergence_id=plan_id, role=IMPLEMENTATION_ROLE[1],
    ):
        request_id = str(row.get("request_id") or "")
        if request_id and derive_request_state(
            request_id=request_id, base_dir=base_dir,
        ) not in TERMINAL_REQUEST_STATES:
            live.append(request_id)
    return live


def converged_plan_ids(*, base_dir: Path) -> list[str]:
    """Plans that fold to CONVERGED, oldest convergence first (one ledger pass)."""
    from .ledger import load_declared_jsonl
    from .plan_convergence import events_path, fold_plan_state

    path = events_path(base_dir)
    if not path.exists():
        return []
    converged_at: dict[str, str] = {}
    for event in load_declared_jsonl(path, expected_surface="plan_convergence_events"):
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event.get("event_type") == "plan_evaluated" and payload.get("terminal_state") == "CONVERGED":
            converged_at[str(event.get("plan_id"))] = str(event.get("recorded_at") or "")
    ordered = sorted(converged_at, key=lambda plan_id: (converged_at[plan_id], plan_id))
    return [
        plan_id for plan_id in ordered
        if fold_plan_state(plan_id=plan_id, base_dir=base_dir).get("state") == "CONVERGED"
    ]


def _withheld(plan_id: str, origin: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "terminal_state": "IMPLEMENTATION_REQUEST_REFUSED",
        "pr_url": None,
        "rejection_class": f"delivery_withheld:{reason}",
        "specialist_review_signal": "review_converged_plan",
        "delivery": {"plan_id": plan_id, "origin": origin, "attempt": None,
                     "withheld": reason, **extra},
    }


def _claim_attempt(
    *, plan_id: str, cycle_id: str, profile: str, runner_class: str, base_dir: Path,
) -> tuple[int | None, str | None, dict[str, Any]]:
    """(attempt number, None) when this offer may run, else (None, reason)."""
    from .plan_convergence import fold_plan_state, record_implementation_delivery_attempt

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "CONVERGED":
        return None, WITHHELD_NOT_CONVERGED, state
    attempts = state.get("implementation_delivery_attempts") or []
    if any(row.get("cycle_id") == cycle_id for row in attempts):
        return None, WITHHELD_OFFERED_THIS_CYCLE, state
    if len(attempts) >= MAX_DELIVERY_ATTEMPTS:
        return None, WITHHELD_EXHAUSTED, state
    if live_implementation_request_ids(plan_id, base_dir=base_dir):
        return None, WITHHELD_REQUEST_LIVE, state
    attempt = len(attempts) + 1
    claimed = record_implementation_delivery_attempt(
        plan_id=plan_id, attempt=attempt, cycle_id=cycle_id,
        profile=profile, runner_class=runner_class, base_dir=base_dir,
    )
    if claimed["idempotent"]:
        return None, WITHHELD_ATTEMPT_TAKEN, state
    return attempt, None, state


def escalate_exhausted_plan(
    plan_id: str, *, base_dir: Path, last_rejection_class: str | None = None,
) -> dict[str, Any]:
    """Hand a plan whose attempts are spent to the operator, then end it.

    The operator record is written FIRST: a plan ended without one would be a
    HUMAN_REQUIRED nobody is told about, while a record without the plan
    transition is retried by the next sweep (both writes are idempotent).
    """
    from .human_required import record_human_required
    from .plan_convergence import fold_plan_state, force_plan_human_required

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "CONVERGED":
        return {"plan_id": plan_id, "status": "not_converged", "state": state.get("state")}
    attempts = [
        {key: row.get(key) for key in ("attempt", "cycle_id", "profile", "runner_class", "recorded_at")}
        for row in state.get("implementation_delivery_attempts") or []
    ]
    request_id = human_required_request_id(plan_id)
    record_human_required(
        request_id=request_id,
        severity="HIGH",
        reason=(
            f"{DELIVERY_EXHAUSTED_REASON}: CONVERGED plan {plan_id} was offered to the "
            f"implementation runner {len(attempts)} times by a lane that could deliver "
            f"it and is still CONVERGED; re-stage it or abandon it"
        ),
        context={
            "kind": HUMAN_REQUIRED_CONTEXT_KIND,
            "plan_id": plan_id,
            "reason_code": DELIVERY_EXHAUSTED_REASON,
            "attempts": attempts,
            "last_rejection_class": last_rejection_class,
            "finding_id": "ARIA-HIGH-362",
        },
        base_dir=base_dir,
    )
    force_plan_human_required(
        plan_id=plan_id,
        round_number=max(1, int(state.get("current_round") or 1)),
        reason_codes=[DELIVERY_EXHAUSTED_REASON],
        base_dir=base_dir,
    )
    return {"plan_id": plan_id, "status": "escalated", "request_id": request_id,
            "attempts": len(attempts)}


def _record_escalation_failure(base_dir: Path, plan_id: str, exc: Exception) -> dict[str, Any]:
    from .tool_registry import append_tools_governance

    append_tools_governance(
        base_dir, "converged_delivery_escalation_failed",
        {"plan_id": plan_id, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
        bypass_profile_gate=True,
    )
    return {"plan_id": plan_id, "status": "escalation_failed", "error_class": type(exc).__name__}


def deliver_converged_plan(
    *,
    runner: Any,
    cycle_id: str,
    plan_id: str,
    workspace_root: Path,
    base_dir: Path,
    cross_review_summary: dict[str, Any],
    profile: str,
    origin: str,
) -> dict[str, Any]:
    """Offer ONE converged plan to the V9 runner — the only call site of ``runner.run``.

    Returns the cycle summary's ``v9_implementation`` shape (terminal_state,
    pr_url, rejection_class, specialist_review_signal) plus ``delivery``: the
    origin, the attempt number this offer counted as (None when uncounted)
    and, when no offer was made, why. A runner fault is caught here, as it
    was at the converging call site, so a V9 failure never blocks specialist
    review; the fault is a governance row and the attempt stays counted.
    """
    from .autonomy_state import AutonomyStateReducer
    from .tool_registry import append_tools_governance

    from .ledger import LedgerIntegrityError
    from .tool_registry import GovernanceError

    runner_class = type(runner).__name__
    attempt: int | None = None
    if holds_implementation_authority(profile):
        try:
            attempt, withheld, _state = _claim_attempt(
                plan_id=plan_id, cycle_id=cycle_id, profile=profile,
                runner_class=runner_class, base_dir=base_dir,
            )
        except (GovernanceError, LedgerIntegrityError, OSError) as exc:
            # The attempt could not be recorded, so no offer is made: an
            # uncounted offer is exactly what the bound exists to prevent.
            # Like a runner fault, it must not block specialist review.
            append_tools_governance(
                base_dir, "converged_delivery_attempt_unrecorded",
                {"cycle_id": cycle_id, "plan_id": plan_id, "delivery_origin": origin,
                 "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            return _withheld(plan_id, origin, WITHHELD_ATTEMPT_UNRECORDED,
                             error_class=type(exc).__name__)
        if withheld is not None:
            return _withheld(plan_id, origin, withheld)
    delivery = {"plan_id": plan_id, "origin": origin, "attempt": attempt, "withheld": None}
    AutonomyStateReducer.transition(
        base_dir, cycle_id=cycle_id, phase="v9_implementation_phase_started",
        status="ok", profile=profile,
        details={"plan_id": plan_id, "runner_class": runner_class,
                 "delivery_origin": origin, "delivery_attempt": attempt},
    )
    try:
        result = runner.run(
            cycle_id=cycle_id,
            plan_id=plan_id,
            workspace_root=workspace_root,
            base_dir=base_dir,
            cross_review_summary=cross_review_summary,
            profile=profile,
        )
        summary: dict[str, Any] = {
            "terminal_state": result.terminal_state,
            "pr_url": result.pr_url,
            "rejection_class": result.rejection_class,
            "specialist_review_signal": result.specialist_review_signal,
        }
        AutonomyStateReducer.transition(
            base_dir, cycle_id=cycle_id, phase="v9_implementation_phase_resolved",
            status=str(result.terminal_state), profile=profile,
            details={"specialist_review_signal": result.specialist_review_signal,
                     "pr_url": result.pr_url, "rejection_class": result.rejection_class,
                     "plan_id": plan_id, "delivery_origin": origin, "delivery_attempt": attempt},
        )
    except Exception as exc:
        # A V9 phase failure must not block specialist_review + worker_drainer.
        # The plan falls back to review_converged_plan (the V8 default) and the
        # counted attempt stands: the next cycle's sweep re-offers it.
        summary = {
            "terminal_state": "IMPLEMENTATION_REQUEST_REFUSED",
            "pr_url": None,
            "rejection_class": f"runner_exception:{type(exc).__name__}",
            "specialist_review_signal": "review_converged_plan",
        }
        try:
            append_tools_governance(
                base_dir, "v9_implementation_phase_failed",
                {"cycle_id": cycle_id, "plan_id": plan_id, "error_class": type(exc).__name__,
                 "delivery_origin": origin, "delivery_attempt": attempt},
                bypass_profile_gate=True,
            )
        except Exception as audit_exc:
            summary["audit_error_class"] = type(audit_exc).__name__
    summary["delivery"] = delivery
    if attempt is not None and attempt >= MAX_DELIVERY_ATTEMPTS:
        try:
            delivery["escalation"] = escalate_exhausted_plan(
                plan_id, base_dir=base_dir, last_rejection_class=summary["rejection_class"],
            )
        except Exception as exc:
            delivery["escalation"] = _record_escalation_failure(base_dir, plan_id, exc)
    return summary


def redeliver_stranded_converged_plans(
    *,
    runner: Any,
    cycle_id: str,
    base_dir: Path,
    workspace_root: Path,
    profile: str,
) -> dict[str, Any]:
    """The per-cycle sweep: re-offer CONVERGED plans an earlier cycle left behind.

    Runs before this cycle adopts or synthesizes a plan, so the plan this
    cycle converges is offered by the converging call and never also by the
    sweep. Every exhausted plan is escalated; at most
    ``REDELIVERIES_PER_CYCLE`` plans are offered; a plan withheld for any
    other reason is reported with that reason.
    """
    from .plan_convergence import fold_plan_state

    report: dict[str, Any] = {
        "stranded": [], "offered": [], "escalated": [], "withheld": {},
        "authority": holds_implementation_authority(profile),
    }
    for plan_id in converged_plan_ids(base_dir=base_dir):
        report["stranded"].append(plan_id)
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        attempts = state.get("implementation_delivery_attempts") or []
        if len(attempts) >= MAX_DELIVERY_ATTEMPTS:
            try:
                report["escalated"].append(escalate_exhausted_plan(plan_id, base_dir=base_dir))
            except Exception as exc:
                report["escalated"].append(_record_escalation_failure(base_dir, plan_id, exc))
            continue
        if not report["authority"]:
            report["withheld"][plan_id] = WITHHELD_NO_AUTHORITY
            continue
        if len(report["offered"]) >= REDELIVERIES_PER_CYCLE:
            report["withheld"][plan_id] = WITHHELD_CYCLE_BOUND
            continue
        body = state.get("latest_revision") or {}
        outcome = deliver_converged_plan(
            runner=runner, cycle_id=cycle_id, plan_id=plan_id,
            workspace_root=workspace_root, base_dir=base_dir,
            cross_review_summary={
                "revision_id": body.get("revision_id") or plan_id,
                "rounds_count": state.get("current_round"),
                "request_ids": [],
            },
            profile=profile, origin=ORIGIN_REDELIVERY,
        )
        if outcome["delivery"].get("withheld"):
            report["withheld"][plan_id] = outcome["delivery"]["withheld"]
            continue
        report["offered"].append({"plan_id": plan_id, **{
            key: outcome.get(key) for key in ("terminal_state", "rejection_class")
        }, "attempt": outcome["delivery"]["attempt"]})
    return report


__all__ = [
    "DELIVERY_EXHAUSTED_REASON",
    "HUMAN_REQUIRED_CONTEXT_KIND",
    "MAX_DELIVERY_ATTEMPTS",
    "ORIGIN_CONVERGED",
    "ORIGIN_REDELIVERY",
    "REDELIVERIES_PER_CYCLE",
    "converged_plan_ids",
    "deliver_converged_plan",
    "escalate_exhausted_plan",
    "holds_implementation_authority",
    "human_required_request_id",
    "live_implementation_request_ids",
    "redeliver_stranded_converged_plans",
]
