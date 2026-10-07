"""ARIA-HIGH-368 / ARIA-HIGH-375 — a plan that ends convergence is reported once, by whoever ended it.

WHY. A plan's convergence outcome used to be reported only by the CYCLE that
reached it: the ``convergence_resolved`` / ``convergence_blocked`` state rows
and the funnel's count. Once the executor advances plans in-run
(``executor_convergence``), it is often the executor that ends one, and the
cycle never sees that plan again (``list_active_plans`` drops terminals). The
outcome rows then had no writer at all, and a plan escalated to
HUMAN_REQUIRED (max rounds, a self-agreeing review, an unanswerable envelope)
sat on the plan ledger with no operator item: parked, silently.

WHAT. One source of truth per outcome: the job that ends the plan reports it,
through this module.

* ``report_executor_terminal`` — the executor's rows for a terminal verdict,
  the same phases and funnel counters the cycle writes. The cycle never
  reports a terminal plan it did not end, so nothing is counted twice.
* ``record_parked_plan`` — ONE operator item per plan that ends
  HUMAN_REQUIRED, keyed by the plan (``plan-human-required-<plan_id>``), so
  every later caller's record is the same record. Both the cycle and the
  executor call it, as does ``converged_delivery`` when it moves an ungated
  CONVERGED plan to HUMAN_REQUIRED.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

PARKED_PLAN_CONTEXT_KIND = "plan_human_required"
EXECUTOR_ORIGIN = "executor"


def parked_plan_request_id(plan_id: str) -> str:
    return f"plan-human-required-{plan_id}"


def _latest_reason_codes(state: dict[str, Any]) -> list[str]:
    for event in reversed(state.get("events") or []):
        if event.get("event_type") == "plan_evaluated":
            return [str(code) for code in (event.get("payload") or {}).get("reason_codes") or []]
    return []


def record_parked_plan(*, plan_id: str, base_dir: Path, verdict: str, origin: str) -> dict[str, Any] | None:
    """The operator item for a plan that ended HUMAN_REQUIRED, or None when it did not.

    Idempotent per plan (``record_human_required`` returns the existing
    record), so a plan escalated, re-judged and reported by several jobs is
    still one item in the operator's queue.
    """
    from .human_required import record_human_required
    from .plan_convergence import fold_plan_state

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "HUMAN_REQUIRED":
        return None
    reasons = _latest_reason_codes(state)
    return record_human_required(
        request_id=parked_plan_request_id(plan_id),
        severity="HIGH",
        reason=(
            f"plan {plan_id} ended convergence HUMAN_REQUIRED ({verdict}: "
            f"{', '.join(reasons) or 'no reason code'}); it advances no further until "
            f"an operator re-stages, revises or abandons it"
        ),
        context={
            "kind": PARKED_PLAN_CONTEXT_KIND,
            "plan_id": plan_id,
            "verdict": verdict,
            "reason_codes": reasons,
            "round_number": state.get("current_round"),
            "origin": origin,
            "finding_id": "ARIA-HIGH-368",
        },
        base_dir=base_dir,
    )


def report_executor_terminal(
    *, plan_id: str, cycle_id: str, verdict: str, rounds: int | None, tools_dir: Path,
    profile: str, pressure_source: str | None,
) -> dict[str, Any]:
    """The cycle's outcome rows for a plan the executor's advance ended.

    ``convergence_resolved`` always; for any verdict but ``converged`` also
    ``convergence_blocked``, the funnel's ``rejected`` count (credited to the
    plan's minting source, as the converged count is) and the operator item.
    The converged count itself is the converged seam's, written before it
    offers the plan.
    """
    from .autonomy_state import AutonomyStateReducer
    from .executor_converged_seam import record_funnel

    details = {"plan_id": plan_id, "rounds_count": rounds, "origin": EXECUTOR_ORIGIN}
    AutonomyStateReducer.transition(
        tools_dir, cycle_id=cycle_id, phase="convergence_resolved", status=verdict,
        profile=profile, details=details,
    )
    report: dict[str, Any] = {"resolved": verdict}
    if verdict == "converged":
        return report
    AutonomyStateReducer.transition(
        tools_dir, cycle_id=cycle_id, phase="convergence_blocked", status=verdict,
        profile=profile, details=details,
    )
    report["funnel"] = record_funnel(
        tools_dir=tools_dir, plan_id=plan_id, cycle_id=cycle_id, source=pressure_source,
        counter="rejected",
    )
    parked = record_parked_plan(plan_id=plan_id, base_dir=tools_dir, verdict=verdict, origin=EXECUTOR_ORIGIN)
    report["operator_item"] = parked_plan_request_id(plan_id) if parked is not None else None
    return report


__all__ = [
    "EXECUTOR_ORIGIN",
    "PARKED_PLAN_CONTEXT_KIND",
    "parked_plan_request_id",
    "record_parked_plan",
    "report_executor_terminal",
]
