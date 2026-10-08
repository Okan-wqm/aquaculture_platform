"""ARIA-HIGH-388 — every implementation request ends on the plan ledger.

THE MEASURED DEFECT (2026-10-08). ``AIR-aria-implementer-e056f97fe09b`` was
refused by its agent (``agent_refused:safety``); the executor wrote a
HUMAN_REQUIRED row and a claim release, and nothing else. Its plan stayed
IMPLEMENTATION_REQUESTED until the orphan reaper relabelled it
``orchestrator_restart_reaped_orphan`` a day later, the real class lost. A
delivery the kernel refused (the apply gate, the PR perimeter, a push) went
the same way. Every learning consumer reads the plan ledger, not governance:
the scorecard (``agent_eval``), the loop guard's cool-off
(``finding_grounding``), finding closure and convention promotion
(``implementation_reconciler``). On the live store ``memory/procedural`` held
24 rows and not one implementer episode, because no implementer outcome ever
reached the ledger.

THE RULE. The job that ends an implementation request settles its plan, here,
in one terminal ``implementation_rejected`` event that carries the rejection
class, the delivery stage and the fault domain. The class comes from the one
table that owns it (``implementation_rejections.DELIVERY_STAGE_SETTLEMENT``);
who is blamed is ``failure_attribution``'s; whether the finding's subject
cools off is ``outage_attribution``'s, reading the same payload. Host faults
(the window, the sandbox, the credential, the missing authority) are never
settled: the executor releases them harness-class and the request is retried.

Settling is idempotent through the plan state machine: a plan already past the
implementation phase refuses a second terminal event, and that refusal is
reported, not raised.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .implementation_rejections import DELIVERY_STAGE_SETTLEMENT, IMPLEMENTER_REFUSED

SETTLEMENT_FAILED_KIND = "implementation_settlement_failed"
SETTLED = "settled"
ALREADY_SETTLED = "already_settled"
NOT_AN_IMPLEMENTATION = "not_an_implementation_request"
FAILED = "failed"
AGENT_REFUSAL_STAGE = "agent_refusal"

_SETTLEABLE_STATES = frozenset({"IMPLEMENTATION_REQUESTED", "IMPLEMENTATION_IN_FLIGHT", "IMPLEMENTATION_RECORDED"})


def _plan_of(request_id: str, base_dir: Path) -> str | None:
    from .agent_invocations import _find_request_by_id

    row = _find_request_by_id(base_dir, request_id) or {}
    if row.get("role") != "implementation":
        return None
    plan_id = row.get("convergence_id")
    return str(plan_id) if isinstance(plan_id, str) and plan_id else None


def _settle(
    *, request_id: str, rejection_class: str, stage: str, fault_domain: str, base_dir: Path,
) -> dict[str, Any]:
    from .ledger import LedgerIntegrityError
    from .plan_convergence import fold_plan_state, record_implementation_rejected
    from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    outcome: dict[str, Any] = {"request_id": request_id, "rejection_class": rejection_class,
                               "stage": stage, "fault_domain": fault_domain}
    try:
        plan_id = _plan_of(request_id, root)
        if plan_id is None:
            return {**outcome, "status": NOT_AN_IMPLEMENTATION}
        outcome["plan_id"] = plan_id
        state = fold_plan_state(plan_id=plan_id, base_dir=root).get("state")
        if state not in _SETTLEABLE_STATES:
            return {**outcome, "status": ALREADY_SETTLED, "plan_state": state}
        record_implementation_rejected(
            plan_id=plan_id, rejection_class=rejection_class,
            rejected_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), base_dir=root,
            settlement={"request_id": request_id, "stage": stage, "fault_domain": fault_domain},
        )
    except (GovernanceError, LedgerIntegrityError, OSError) as exc:
        # The request's own terminal (its release, its HUMAN_REQUIRED row) is
        # already written; a settlement the store refused is a row, and the
        # orphan reaper still ends the plan.
        append_tools_governance(
            root, SETTLEMENT_FAILED_KIND,
            {**outcome, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        return {**outcome, "status": FAILED, "error_class": type(exc).__name__}
    return {**outcome, "status": SETTLED}


def settle_agent_refusal(*, request_id: str, base_dir: Path) -> dict[str, Any]:
    """The implementer refused the request: the plan ends ``implementer_refused``.

    Request-class: the refusal judges the plan it was handed (the scorecard
    does not blame the implementer, ``failure_attribution``). A refusal that
    is really the host's (a missing commit identity, a missing toolchain)
    must be refused before the spawn as a harness fault, by the admission
    that owns that precondition; it is not reclassified here.
    """
    return _settle(request_id=request_id, rejection_class=IMPLEMENTER_REFUSED,
                   stage=AGENT_REFUSAL_STAGE, fault_domain="request", base_dir=base_dir)


def settle_delivery_refusal(*, request_id: str, stage: str, base_dir: Path) -> dict[str, Any]:
    """The kernel refused the delivery at ``stage``: the plan ends with that stage's class.

    A host stage has no settlement (``DELIVERY_STAGE_SETTLEMENT`` omits it)
    and raises: the caller releases those harness-class instead.
    """
    if stage not in DELIVERY_STAGE_SETTLEMENT:
        raise ValueError(f"delivery stage {stage!r} is not settled (a host stage is retried)")
    rejection_class, fault_domain = DELIVERY_STAGE_SETTLEMENT[stage]
    return _settle(request_id=request_id, rejection_class=rejection_class, stage=stage,
                   fault_domain=fault_domain, base_dir=base_dir)


__all__ = [
    "AGENT_REFUSAL_STAGE",
    "ALREADY_SETTLED",
    "FAILED",
    "NOT_AN_IMPLEMENTATION",
    "SETTLED",
    "SETTLEMENT_FAILED_KIND",
    "settle_agent_refusal",
    "settle_delivery_refusal",
]
