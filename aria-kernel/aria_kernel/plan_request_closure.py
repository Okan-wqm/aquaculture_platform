"""An ABANDONED plan's queued requests close with it (ARIA-HIGH-367, H4).

WHY. ``abandon_plan`` ended the plan and nothing else: its PENDING/REQUEUED
requests stayed claimable, and claim selection (``next_pending_request``)
never asks whose plan a request serves. After an outage that is the worst
moment to spend quota — the recovered provider's first answers went to
requests whose bridge into the plan is refused (the plan is terminal), ahead
of the live plan's work. A closed plan's queue is now closed by one claim
event, ``plan_closed``, which ``derive_request_state`` reads as CANCELLED (an
existing terminal; no new state). A request already CLAIMED or RUNNING is left
to finish — its lease, not this module, ends it.

Two callers make it automatic: ``abandon_plan`` closes the plan's queue as it
records the abandonment, and ``sweep_expired_anchors`` (run before every mint)
closes the queue of any plan abandoned before this existed.

ARIA-HIGH-388 (re-review N4) — the same closure ends an IMPLEMENTATION request
whose plan left its implementation phase (settled, reaped, merged): it was
skipped by every selection forever and folded on each one. The settlement
(``implementation_settlement``) closes its plan's queue as it settles.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .ledger import load_jsonl, state_transaction
from .tool_registry import append_tools_governance, ensure_tools_dir

PLAN_CLOSED_EVENT = "plan_closed"
# The latest claim event of a request nobody holds (PENDING has none).
# `human_required` is unheld too (PR #1835 review MEDIUM-4): an escalation the
# re-derivation healed derives PENDING/REQUEUED again and must close with its
# ABANDONED plan; a standing one derives HUMAN_REQUIRED and is filtered below.
_UNHELD_EVENTS: frozenset[str | None] = frozenset({None, "released", "requeued", "human_required"})
# ARIA-HIGH-388 (re-review N4) — the plan states an implementation request
# can no longer serve: the implementation phase ended (rejected, merged), or
# the plan never will (abandoned, escalated). CONVERGED is deliberately
# absent: the implementation mint appends its request row BEFORE the plan's
# `implementation_requested` event, and a request on a still-CONVERGED plan
# is that crash window, which `converged_delivery` recovers
# (`WITHHELD_REQUEST_LIVE`). Closing it here would undo that recovery.
_IMPLEMENTATION_CLOSED_STATES: frozenset[str] = frozenset({
    "IMPLEMENTATION_REJECTED", "IMPLEMENTATION_MERGED", "ABANDONED", "HUMAN_REQUIRED",
})


def _closure_reason(role: object, state: str | None) -> str | None:
    """Why a request of ``role`` closes with a plan in ``state``, or None."""
    if state == "ABANDONED":
        return "plan_abandoned"
    if role == "implementation" and state in _IMPLEMENTATION_CLOSED_STATES:
        return "plan_left_implementation"
    return None


def close_abandoned_plan_requests(
    base_dir: str | Path | None, *, plan_ids: Iterable[str] | None = None, now: datetime | None = None,
) -> list[str]:
    """Close every unheld request of an ABANDONED plan, and every unheld
    IMPLEMENTATION request of a plan whose implementation phase ended
    (``_closure_reason``; ``plan_ids`` None: every plan)."""
    from .agent_invocations import _claims_path, _event_ts, _latest_claim_row, derive_request_states
    from .agent_invocations import list_agent_invocation_requests
    from .plan_convergence import fold_plan_state

    root = ensure_tools_dir(base_dir)
    wanted = set(plan_ids) if plan_ids is not None else None
    claims_path = _claims_path(root)
    latest_event: dict[str, tuple[Any, str | None]] = {}
    for claim in (load_jsonl(claims_path) if claims_path.is_file() else []):
        rid, ts = str(claim.get("request_id")), _event_ts(claim)
        if rid not in latest_event or ts >= latest_event[rid][0]:
            latest_event[rid] = (ts, claim.get("event"))  # `_latest_claim_row`'s rule, one pass
    plan_states: dict[str, str | None] = {}
    rows: list[tuple[dict[str, Any], str]] = []
    for row in list_agent_invocation_requests(base_dir=root):
        plan_id = row.get("convergence_id")
        if not isinstance(plan_id, str) or (wanted is not None and plan_id not in wanted):
            continue
        # Cheap pre-filter from the claims ledger alone: the batch derivation
        # below runs only when some abandoned plan still has an unheld request
        # (the sweep that calls this already paid for one, ORPHAN-HIGH-794).
        if latest_event.get(str(row.get("request_id")), (None, None))[1] not in _UNHELD_EVENTS:
            continue
        if plan_id not in plan_states:
            plan_states[plan_id] = fold_plan_state(plan_id=plan_id, base_dir=root).get("state")
        reason = _closure_reason(row.get("role"), plan_states[plan_id])
        if reason is not None:
            rows.append((row, reason))
    if not rows:
        return []
    states = derive_request_states(base_dir=root)
    candidates = [(row, reason) for row, reason in rows
                  if states.get(str(row.get("request_id"))) in ("PENDING", "REQUEUED")]
    if not candidates:
        return []
    moment = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    closed: list[str] = []
    with state_transaction([claims_path]) as transaction:
        claims = transaction.load_declared_jsonl(claims_path, expected_surface="agent_invocation_claims")
        for row, reason in candidates:
            request_id = str(row["request_id"])
            latest = _latest_claim_row(claims, request_id)
            if (latest or {}).get("event") not in _UNHELD_EVENTS:
                continue  # claimed since the derivation: its lease decides
            transaction.append_declared_jsonl(claims_path, {
                "schema_version": 1, "event": PLAN_CLOSED_EVENT, "request_id": request_id,
                "plan_id": row["convergence_id"], "at": moment, "reason": reason,
            }, expected_surface="agent_invocation_claims")
            closed.append(request_id)
    if closed:
        append_tools_governance(root, "agent_requests_closed_with_plan", {
            "request_ids": closed, "plan_ids": sorted({str(r["convergence_id"]) for r, _reason in candidates}),
        })
    return closed


__all__ = ["PLAN_CLOSED_EVENT", "close_abandoned_plan_requests"]
