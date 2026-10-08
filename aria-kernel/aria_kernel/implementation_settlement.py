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
    settlement_for_post_delivery,
    settlement_for_pre_spawn,
)

SETTLEMENT_FAILED_KIND = "implementation_settlement_failed"
SETTLED = "settled"
ALREADY_SETTLED = "already_settled"
NOT_AN_IMPLEMENTATION = "not_an_implementation_request"
FAILED = "failed"
CLAIMED_IN_FLIGHT = "claimed_in_flight"


def _plan_of(request_id: str, base_dir: Path) -> str | None:
    from .agent_invocations import _find_request_by_id

    row = _find_request_by_id(base_dir, request_id) or {}
    if row.get("role") != "implementation":
        return None
    plan_id = row.get("convergence_id")
    return str(plan_id) if isinstance(plan_id, str) and plan_id else None


# Re-review N5 — the plan lock is held for milliseconds by every plan writer;
# a settlement that met it gave up and left the plan for the orphan reaper.
# Three attempts, a second apart, cover any writer that holds it briefly.
SETTLE_LOCK_ATTEMPTS = 3
SETTLE_LOCK_BACKOFF_SECONDS = 1.0


def _settle_with_bounded_retry(*, plan_id: str, settlement: ImplementationSettlement, root: Path) -> dict[str, Any]:
    import time

    from .plan_convergence import PlanLedgerLocked, settle_implementation_rejected

    attempt = 1
    while True:
        try:
            return settle_implementation_rejected(
                plan_id=plan_id, settlement=settlement, base_dir=root,
                rejected_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            )
        except PlanLedgerLocked:
            if attempt >= SETTLE_LOCK_ATTEMPTS:
                raise
            time.sleep(SETTLE_LOCK_BACKOFF_SECONDS * attempt)
            attempt += 1


def _settle(settlement: ImplementationSettlement, *, base_dir: Path, plan_id: str | None = None) -> dict[str, Any]:
    from .ledger import LedgerIntegrityError
    from .plan_convergence import PlanLedgerLocked, PlanStateRefused
    from .tool_registry import append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    outcome: dict[str, Any] = {"rejection_class": settlement.rejection_class, **settlement.payload()}
    plan_id = plan_id or _plan_of(settlement.request_id, root)
    if plan_id is None:
        return {**outcome, "status": NOT_AN_IMPLEMENTATION}
    outcome["plan_id"] = plan_id
    try:
        written = _settle_with_bounded_retry(plan_id=plan_id, settlement=settlement, root=root)
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
    if written.get("idempotent"):
        return {**outcome, "status": ALREADY_SETTLED}
    # The plan's other unheld implementation requests close with it
    # (`plan_request_closure`), so no selection ever folds them again.
    from .plan_request_closure import close_abandoned_plan_requests

    try:
        outcome["closed_requests"] = close_abandoned_plan_requests(root, plan_ids=[plan_id])
    except (LedgerIntegrityError, OSError) as exc:
        outcome["closed_requests_error"] = type(exc).__name__
    return {**outcome, "status": SETTLED}


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


def _wait_of(request: dict[str, Any] | None, *, root: Path) -> tuple[str, bool]:
    """(cause, still waiting on the lane) for the plan's newest implementation request."""
    from .agent_invocations import _claims_path, derive_request_state
    from .implementation_dispatch import implementation_dispatch_refusal
    from .ledger import load_jsonl
    from .outage_causality import WAITING_STATES
    from .release_reason import parse_release_reason

    if request is None:
        return "no_request", True
    request_id = str(request.get("request_id") or "")
    state = derive_request_state(request_id=request_id, base_dir=root)
    undispatchable = implementation_dispatch_refusal(request=request, base_dir=root)
    if state in WAITING_STATES and undispatchable is not None:
        return undispatchable, True
    path = _claims_path(root)
    reasoned = [row for row in (load_jsonl(path) if path.is_file() else [])
                if row.get("request_id") == request_id and isinstance(row.get("reason"), str) and row["reason"].strip()]
    last = reasoned[-1]["reason"] if reasoned else None
    if last is not None and parse_release_reason(last).fault_domain == "harness":
        return last, True
    if state == "CLAIMED":
        # Final review R2 — a claim row carries no reason; a request held by
        # a live claim at the reap was in flight, not unclaimed.
        return CLAIMED_IN_FLIGHT, False
    return (last or "unclaimed"), state in WAITING_STATES


def settle_orphaned_plan(*, plan_id: str, base_dir: Path) -> dict[str, Any]:
    """The orphan reaper's terminal for ``plan_id``, through the one settlement
    writer (ARIA-HIGH-388): ``implementation_settlement.settlement_for_orphan``
    decides the fault domain from the newest implementation request's wait,
    and the state is checked under the plan lock, so an executor that settled
    first leaves this ``already_settled``."""
    from .agent_invocations import list_agent_invocation_requests
    from .implementation_rejections import settlement_for_orphan
    from .outage_causality import newest_request_id
    from .tool_registry import ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    requests = list_agent_invocation_requests(base_dir=root)
    request_id = newest_request_id(requests, plan_id=plan_id, role="implementation")
    request = next((row for row in requests if row.get("request_id") == request_id), None)
    cause, waiting = _wait_of(request, root=root)
    return _settle(settlement_for_orphan(request_id=request_id or "", wait_cause=cause, waiting=waiting),
                   base_dir=root, plan_id=plan_id)


def hand_over_delivered_implementation(
    *, request_id: str, cause: str, pr_number: int, pr_url: str, branch: str, branch_tip_sha: str,
    base_dir: Path,
) -> dict[str, Any]:
    """ARIA-HIGH-389 — a result refused AFTER the kernel's delivery opened its PR.

    A retry cannot happen (the published branch collides), so the plan ends
    here (``implementation_result_refused_after_delivery``, stage
    ``post_delivery``, the PR's number on the event), and the live PR is
    handed to a person as its ``human-merge-pr-<n>`` record
    (``human_merge_surface.record_handed_over_pr``): GitHub-observable, so
    the cycle's surface resolves it when the PR is merged or closed. The
    record is written whatever the settlement's status: the PR is open
    either way. The PR facts are the kernel's delivery's, never the agent's.
    A person's merge of that PR is not yet folded onto the plan ledger
    (ARIA-HIGH-390).
    """
    from .human_merge_surface import record_handed_over_pr
    from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    outcome = _settle(settlement_for_post_delivery(request_id=request_id, cause=cause, pr_number=pr_number),
                      base_dir=root)
    from .agent_invocations import _find_request_by_id

    # The change the kernel minted for this request (its implementation ids),
    # the same id the PR's `opened` lifecycle row carries.
    minted = (_find_request_by_id(root, request_id) or {}).get("implementation_ids") or {}
    try:
        outcome["handed_over"] = record_handed_over_pr(
            pr_number=pr_number, pr_url=pr_url, branch=branch, head_sha=branch_tip_sha,
            change_id=str(minted.get("change_id") or "") or None, plan_id=outcome.get("plan_id"), request_id=request_id, rejection_class=outcome["rejection_class"],
            cause=outcome["cause"], settlement_status=outcome["status"], base_dir=root,
        )
    except (GovernanceError, OSError) as exc:
        append_tools_governance(
            root, SETTLEMENT_FAILED_KIND,
            {**{key: value for key, value in outcome.items() if key != "status"}, "stage_failed": "hand_over",
             "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        outcome["handed_over"] = None
    return outcome


def rejected_plan_for_change(change_id: str, *, base_dir: Path) -> dict[str, Any] | None:
    """The settlement that ended the plan which minted ``change_id``, or None
    while that plan is not IMPLEMENTATION_REJECTED (ARIA-HIGH-389).

    Read by ``human_merge_surface`` for every open ARIA PR (whose ``opened``
    row carries the change): a PR whose plan ended, by the executor's
    hand-over or by the orphan reaper after a run that died past its
    delivery, is a person's, because no merge lane merges from a rejected
    plan (``merge_authority``). The plan state is the one source; the
    change is the kernel's mint (the request's ``implementation_ids``).
    """
    from .agent_invocations import list_agent_invocation_requests
    from .ledger import load_jsonl
    from .plan_convergence import events_path, fold_plan_state
    from .tool_registry import ensure_tools_dir

    if not change_id:
        return None
    root = ensure_tools_dir(base_dir)
    plan_ids = {str(row.get("convergence_id")) for row in list_agent_invocation_requests(base_dir=root)
                if row.get("role") == "implementation" and row.get("convergence_id")
                and (row.get("implementation_ids") or {}).get("change_id") == change_id}
    for plan_id in sorted(plan_ids):
        if fold_plan_state(plan_id=plan_id, base_dir=root).get("state") != "IMPLEMENTATION_REJECTED":
            continue
        rejected = [row.get("payload") or {} for row in load_jsonl(events_path(root))
                    if row.get("plan_id") == plan_id and row.get("event_type") == "implementation_rejected"]
        return {"plan_id": plan_id, **(rejected[-1] if rejected else {})}
    return None


__all__ = [
    "ALREADY_SETTLED",
    "FAILED",
    "NOT_AN_IMPLEMENTATION",
    "SETTLED",
    "SETTLEMENT_FAILED_KIND",
    "hand_over_delivered_implementation",
    "rejected_plan_for_change",
    "settle_agent_refusal",
    "settle_delivery_refusal",
    "settle_orphaned_plan",
    "settle_pre_spawn_refusal",
]
