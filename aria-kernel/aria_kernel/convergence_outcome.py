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


# ARIA-HIGH-375 (second review) — reason codes the OPERATOR's own transition
# names (`plan force-human-required --reason-code operator_withdrawn`): the
# operator parked the plan, so its item is recorded already resolved rather
# than handed back to the person who just made the decision.
OPERATOR_REASON_PREFIX = "operator_"
PARKED_DISPOSITION_LEFT = "plan_left_human_required"
PARKED_DISPOSITION_OPERATOR = "parked_by_operator"
RECONCILE_FAILED_KIND = "parked_plan_reconcile_failed"


def parked_plan_request_id(plan_id: str, generation: int = 1) -> str:
    """The operator item for the ``generation``-th time ``plan_id`` entered
    HUMAN_REQUIRED. A re-parked plan gets a FRESH id (``-2``, ``-3``): the
    item an earlier parking resolved is never handed back as the open one
    (``record_human_required`` returns an existing record as it is)."""
    base = f"plan-human-required-{plan_id}"
    return base if generation <= 1 else f"{base}-{generation}"


def _human_required_evaluations(state: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        event.get("payload") or {}
        for event in state.get("events") or []
        if event.get("event_type") == "plan_evaluated"
        and (event.get("payload") or {}).get("terminal_state") == "HUMAN_REQUIRED"
    ]


def _latest_reason_codes(state: dict[str, Any]) -> list[str]:
    for event in reversed(state.get("events") or []):
        if event.get("event_type") == "plan_evaluated":
            return [str(code) for code in (event.get("payload") or {}).get("reason_codes") or []]
    return []


def record_parked_plan(*, plan_id: str, base_dir: Path, verdict: str, origin: str) -> dict[str, Any] | None:
    """The operator item for a plan that ended HUMAN_REQUIRED, or None when it did not.

    Idempotent per (plan, parking): ``record_human_required`` returns the
    existing record, so a plan escalated, re-judged and reported by several
    jobs is still one item in the operator's queue. A plan the operator
    parked himself is recorded resolved, by the kernel, saying so.
    """
    from .human_required import record_human_required, write_kernel_disposition
    from .plan_convergence import fold_plan_state

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    if state.get("state") != "HUMAN_REQUIRED":
        return None
    reasons = _latest_reason_codes(state)
    request_id = parked_plan_request_id(plan_id, len(_human_required_evaluations(state)))
    reason = (
        f"plan {plan_id} ended convergence HUMAN_REQUIRED ({verdict}: "
        f"{', '.join(reasons) or 'no reason code'}); it advances no further until "
        f"an operator re-stages, revises or abandons it"
    )
    context = {
        "kind": PARKED_PLAN_CONTEXT_KIND,
        "plan_id": plan_id,
        "verdict": verdict,
        "reason_codes": reasons,
        "round_number": state.get("current_round"),
        "origin": origin,
        "finding_id": "ARIA-HIGH-368",
    }
    if reasons and all(code.startswith(OPERATOR_REASON_PREFIX) for code in reasons):
        written = write_kernel_disposition(item={
            "request_id": request_id, "severity": "HIGH", "reason": reason, "context": context,
            "status": "resolved",
            "disposition": {"disposition": PARKED_DISPOSITION_OPERATOR,
                            "reason": f"the operator parked it ({', '.join(reasons)})",
                            "finding_id": "ARIA-HIGH-375"},
        }, base_dir=base_dir)
        return written or {"request_id": request_id, "status": "resolved"}
    return record_human_required(
        request_id=request_id, severity="HIGH", reason=reason, context=context, base_dir=base_dir,
    )


def _resolve_left_items(*, plan_id: str, state: dict[str, Any], base_dir: Path) -> list[str]:
    """Resolve every parked item of a plan that is no longer HUMAN_REQUIRED."""
    from .human_required import write_kernel_disposition

    resolved: list[str] = []
    for generation in range(1, len(_human_required_evaluations(state)) + 1):
        request_id = parked_plan_request_id(plan_id, generation)
        if not (base_dir / "human-required" / f"{request_id}.json").exists():
            continue
        written = write_kernel_disposition(item={
            "request_id": request_id, "severity": "HIGH", "reason": f"plan {plan_id} parked",
            "context": {"kind": PARKED_PLAN_CONTEXT_KIND, "plan_id": plan_id},
            "status": "resolved",
            "disposition": {"disposition": PARKED_DISPOSITION_LEFT,
                            "reason": f"plan {plan_id} is now {state.get('state')}",
                            "finding_id": "ARIA-HIGH-375"},
        }, base_dir=base_dir)
        if written is not None:
            resolved.append(request_id)
    return resolved


def reconcile_parked_plans(*, base_dir: Path) -> dict[str, Any]:
    """The ONE place the parked-plan invariant is guaranteed, once per cycle.

    Every plan that is HUMAN_REQUIRED has its operator item, and every item
    of a plan that left HUMAN_REQUIRED (abandoned, or moved on by an
    operator) is resolved by the kernel. The writers that park a plan (the
    cycle, the executor, the independence migration) write the item next to
    the transition, but not atomically with it: a fault between the two
    left a HUMAN_REQUIRED plan no scan would ever look at again. A fault on
    one plan is a governance row and the rest are still reconciled.
    """
    from .ledger import LedgerIntegrityError, load_declared_jsonl
    from .plan_convergence import events_path, fold_plan_state
    from .tool_registry import GovernanceError, append_tools_governance

    report: dict[str, Any] = {"recorded": [], "resolved": [], "failed": []}
    path = events_path(base_dir)
    if not path.exists():
        return report
    try:
        parked_ever = sorted({
            str(event.get("plan_id"))
            for event in load_declared_jsonl(path, expected_surface="plan_convergence_events")
            if event.get("event_type") == "plan_evaluated"
            and (event.get("payload") or {}).get("terminal_state") == "HUMAN_REQUIRED"
        })
    except (GovernanceError, LedgerIntegrityError, OSError) as exc:
        append_tools_governance(
            base_dir, RECONCILE_FAILED_KIND,
            {"plan_id": None, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        report["failed"].append(None)
        return report
    for plan_id in parked_ever:
        try:
            state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
            if state.get("state") == "HUMAN_REQUIRED":
                generation = len(_human_required_evaluations(state))
                request_id = parked_plan_request_id(plan_id, generation)
                if not (base_dir / "human-required" / f"{request_id}.json").exists():
                    record_parked_plan(plan_id=plan_id, base_dir=base_dir,
                                       verdict="human_required", origin="reconcile")
                    report["recorded"].append(request_id)
            else:
                report["resolved"].extend(_resolve_left_items(plan_id=plan_id, state=state, base_dir=base_dir))
        except (GovernanceError, LedgerIntegrityError, OSError) as exc:
            append_tools_governance(
                base_dir, RECONCILE_FAILED_KIND,
                {"plan_id": plan_id, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            report["failed"].append(plan_id)
    return report


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
    report["operator_item"] = parked.get("request_id") if parked is not None else None
    return report


__all__ = [
    "EXECUTOR_ORIGIN",
    "OPERATOR_REASON_PREFIX",
    "PARKED_DISPOSITION_LEFT",
    "PARKED_DISPOSITION_OPERATOR",
    "PARKED_PLAN_CONTEXT_KIND",
    "RECONCILE_FAILED_KIND",
    "parked_plan_request_id",
    "reconcile_parked_plans",
    "record_parked_plan",
    "report_executor_terminal",
]
