"""ARIA-HIGH-388 — whether an implementation request may be handed out at all.

WHY (adversarial review of cd2166bb4, HIGH-2). The delivery's authority was
checked only at the delivery's admission, AFTER the executor had claimed the
request, minted the implementer's signing identity and admitted a real GitHub
App delivery credential. Released harness-class with its budget intact and no
bound, a request minted under ``strict`` was re-claimed and re-minted by every
executor run for as long as the profile stayed ``standard``. And a request
whose plan had already ended (the orphan reaper rejects a plan after 24 h) was
still PENDING: when the authority came back, the implementer would have run on
a dead plan and pushed a branch and a PR nobody could settle.

THE RULE. An implementation request is DISPATCHABLE only while the store's
profile holds the delivery's actions (``implementation_delivery.
delivery_authority_refusal``, the one check) and its plan is still waiting for
an implementation (IMPLEMENTATION_REQUESTED / IN_FLIGHT). The queue's
selection skips an undispatchable request before any claim, so nothing is
minted and nothing is spent; the executor asks the same question first, for a
targeted dispatch. The skip is disclosed once per (request, cause).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

IMPLEMENTATION_ROLE = "implementation"
UNDISPATCHABLE_KIND = "implementation_request_undispatchable"
PLAN_NOT_AWAITING_PREFIX = "plan_not_awaiting_implementation"
AWAITING_STATES: frozenset[str] = frozenset({"IMPLEMENTATION_REQUESTED", "IMPLEMENTATION_IN_FLIGHT"})

# One disclosure per (request, cause) per process: the selection asks this
# for every candidate of every role filter, many times per drain, and the
# governance-once scan reads the whole ledger.
_DISCLOSED: set[tuple[str, str, str]] = set()


def implementation_dispatch_refusal(*, request: Mapping[str, Any], base_dir: str | Path) -> str | None:
    """Why ``request`` must not be handed out now, or None (not an implementation request: None)."""
    from .implementation_delivery import delivery_authority_refusal
    from .plan_convergence import fold_plan_state

    if request.get("role") != IMPLEMENTATION_ROLE:
        return None
    refused = delivery_authority_refusal(base_dir=base_dir)
    if refused is not None:
        return refused
    plan_id = request.get("convergence_id")
    state = fold_plan_state(plan_id=str(plan_id), base_dir=base_dir).get("state") if plan_id else None
    if state not in AWAITING_STATES:
        return f"{PLAN_NOT_AWAITING_PREFIX}:{state}"
    return None


def disclose_undispatchable(*, request: Mapping[str, Any], reason: str, base_dir: str | Path) -> None:
    """One governance row per (request, cause): an operator sees why the queue holds it."""
    from .tool_registry import append_tools_governance_once, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    request_id = str(request.get("request_id") or "")
    cause = reason.split(":", 1)[0]
    key = (str(root), request_id, cause)
    if key in _DISCLOSED:
        return
    _DISCLOSED.add(key)
    append_tools_governance_once(
        root, UNDISPATCHABLE_KIND,
        {"request_id": request_id, "plan_id": request.get("convergence_id"), "cause": cause, "reason": reason},
        claim_keys=("request_id", "cause"),
    )


__all__ = [
    "AWAITING_STATES",
    "PLAN_NOT_AWAITING_PREFIX",
    "UNDISPATCHABLE_KIND",
    "disclose_undispatchable",
    "implementation_dispatch_refusal",
]
