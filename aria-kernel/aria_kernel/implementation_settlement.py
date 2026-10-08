"""ARIA-HIGH-388 — an implementation request's terminal outcome ends its plan on the plan ledger.

THE MEASURED DEFECT (2026-10-08). ``AIR-aria-implementer-e056f97fe09b`` was
refused by its agent (``agent_refused:safety``); the executor wrote a
HUMAN_REQUIRED row and a claim release and nothing else. Its plan stayed
IMPLEMENTATION_REQUESTED until the orphan reaper relabelled it
``orchestrator_restart_reaped_orphan`` a day later, the real cause lost. A
delivery the kernel refused went the same way. Every learning consumer reads
the plan ledger, not governance: the scorecard (``agent_eval``), the loop
guard's cool-off (``finding_grounding``), finding closure and convention
promotion (``implementation_reconciler``). ``memory/procedural`` held 24
episodes and not one implementer episode.

THE RULE. The job that ends an implementation request settles its plan here,
in one ``implementation_rejected`` event whose typed payload names the class,
the fault domain, the stage, the cause and the request. WHO decides the
domain: ``implementation_rejections.settlement_for_*`` (``request`` only where
the kernel verifies the cause is the work's; an agent's own refusal is never
verifiable and settles ``unclassified``). WHO is blamed:
``failure_attribution``. WHETHER the finding cools off:
``outage_attribution``, which cools off on a verified ``request`` fault only.

Host faults that leave nothing published (the window, the sandbox, the
credential, the missing authority) are never settled: the executor releases
them harness-class and the request is retried in place. A refusal after the
branch is published cannot be retried in place (the branch collides), so it
ends the plan; ``harness`` and ``unclassified`` ends cool nothing off, and the
finding is re-planned by the next cycle.

Idempotent through the plan state machine: the state is checked inside the
plan lock (``plan_convergence.settle_implementation_rejected``), and a plan
already past its implementation phase is reported ``already_settled``. A lock
or store fault is a governance row, never an exception in the executor.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .implementation_rejections import (
    ImplementationSettlement,
    settlement_for_agent_refusal,
    settlement_for_delivery,
    settlement_for_pre_spawn,
)

SETTLEMENT_FAILED_KIND = "implementation_settlement_failed"
SETTLED = "settled"
ALREADY_SETTLED = "already_settled"
NOT_AN_IMPLEMENTATION = "not_an_implementation_request"
FAILED = "failed"


def _plan_of(request_id: str, base_dir: Path) -> str | None:
    from .agent_invocations import _find_request_by_id

    row = _find_request_by_id(base_dir, request_id) or {}
    if row.get("role") != "implementation":
        return None
    plan_id = row.get("convergence_id")
    return str(plan_id) if isinstance(plan_id, str) and plan_id else None


def _settle(settlement: ImplementationSettlement, *, base_dir: Path) -> dict[str, Any]:
    from .ledger import LedgerIntegrityError
    from .plan_convergence import PlanLedgerLocked, PlanStateRefused, settle_implementation_rejected
    from .tool_registry import append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    outcome: dict[str, Any] = {"rejection_class": settlement.rejection_class, **settlement.payload()}
    plan_id = _plan_of(settlement.request_id, root)
    if plan_id is None:
        return {**outcome, "status": NOT_AN_IMPLEMENTATION}
    outcome["plan_id"] = plan_id
    try:
        written = settle_implementation_rejected(
            plan_id=plan_id, settlement=settlement, base_dir=root,
            rejected_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
    except PlanStateRefused as refused:
        return {**outcome, "status": ALREADY_SETTLED, "detail": str(refused)[:200]}
    except (PlanLedgerLocked, LedgerIntegrityError, OSError) as exc:
        # The request's own terminal (its release, its HUMAN_REQUIRED row) is
        # written already; a settlement the store refused is a row. A
        # programming error (an invalid class, a malformed payload) raises.
        append_tools_governance(
            root, SETTLEMENT_FAILED_KIND,
            {**outcome, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        return {**outcome, "status": FAILED, "error_class": type(exc).__name__}
    # The same settlement replayed (an executor re-run) is the event already on
    # the ledger, returned by its idempotency key.
    return {**outcome, "status": ALREADY_SETTLED if written.get("idempotent") else SETTLED}


def settle_agent_refusal(*, request_id: str, reason_class: str, base_dir: Path) -> dict[str, Any]:
    """The implementer refused: ``implementer_refused``, ``unclassified``."""
    return _settle(settlement_for_agent_refusal(reason_class=reason_class, request_id=request_id),
                   base_dir=base_dir)


def settle_delivery_refusal(*, request_id: str, stage: str, reason: str, base_dir: Path) -> dict[str, Any]:
    """The kernel refused the delivery at ``stage`` for ``reason``."""
    return _settle(settlement_for_delivery(stage=stage, reason=reason, request_id=request_id),
                   base_dir=base_dir)


def settle_pre_spawn_refusal(*, request_id: str, release_reason: str, base_dir: Path) -> dict[str, Any]:
    """A pre-spawn refusal that ends the request for good (``PRE_SPAWN_SETTLEMENT``)."""
    return _settle(settlement_for_pre_spawn(release_reason=release_reason, request_id=request_id),
                   base_dir=base_dir)


__all__ = [
    "ALREADY_SETTLED",
    "FAILED",
    "NOT_AN_IMPLEMENTATION",
    "SETTLED",
    "SETTLEMENT_FAILED_KIND",
    "settle_agent_refusal",
    "settle_delivery_refusal",
    "settle_pre_spawn_refusal",
]
