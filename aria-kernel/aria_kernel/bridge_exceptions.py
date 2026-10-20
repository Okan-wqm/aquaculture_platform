"""Plan ARIA-V8 v2 §4 Phase 8.2 (B-V2-03) — bridge contract exceptions.

WHY: ``plan_convergence_bridge.record_plan_result`` can detect
structurally-invalid invocations (e.g. role=primary_plan on DRAFT
state when V8 says round-1 has no primary envelope). The pre-V8
behavior was to raise ``GovernanceError`` which the caller at
``agent_invocations._submit_legacy_invocation_result_internal``
wraps in ``agent_bridge_warning`` and DOES NOT undo the accept.
The "operator-visible" GovernanceError of V8 v1 was silently
swallowed.

HOW: introduce a typed marker subclass ``BridgeContractViolation``.
The caller re-raises this specific subclass explicitly (vs swallowing
plain GovernanceError). Other bridge errors continue to flow through
the existing agent_bridge_warning path — no regression on legacy
bridges.

Per B-V2-03: this is the typed-exception mechanism that makes the
operator-visible promise honest.

ARIA-MEDIUM-172 — a SECOND marker, ``BridgeContractRefused``, types the
other deterministic class: a CONTENT refusal (a judge verdict outside
the vocabulary, a supporting payload that is not an object, a missing
plan id) whose input is a pure function of the request/response pair,
so the same envelope is refused again on every replay. ``Violation``
means "the producer broke a structural contract; re-invoking is
unsafe"; ``Refused`` means "this payload can never fold; re-invoking
is useless". Both end the retry lane by name; everything else stays a
transient ``GovernanceError`` that the budget may still spend.
``DETERMINISTIC_BRIDGE_FAILURES`` is the one tuple both retry deciders
read. ``Refused`` is a SIBLING of ``Violation``, not a subclass: seven
modules catch ``Violation`` to re-raise or classify it
(agent_invocations, bridge_status_ledger, converged_delivery,
convergence_drainer, cycle_phases.implementer, implementation_replan,
executor_convergence), and a subclass in either direction would
cross-catch where those sites' semantics must not change.
"""
from __future__ import annotations

from .tool_registry import GovernanceError


class BridgeContractViolation(GovernanceError):
    """Bridge-side detection of a structural contract violation.

    Caller MUST re-raise this exception explicitly — do NOT swallow
    into agent_bridge_warning. Indicates the producer (round dispatch,
    envelope mint, role mapping) violated a load-bearing contract.
    """


class BridgeContractRefused(GovernanceError):
    """Bridge-side detection of a deterministic CONTENT refusal.

    The refused input is a pure function of the request/response pair
    (a verdict outside the vocabulary, a non-object envelope, a missing
    id), so re-invoking the bridge on the same sealed bytes is useless,
    not unlucky. The retry lane records it and ends by name
    (``terminal_reason="refused"``) instead of spending the budget.
    """


# The bridge failures a replay can never out-live: a refusal (the same
# input is refused again) or a violation (re-invoking after the state
# moved would fold a stale answer). Every other GovernanceError is a
# transient the retry budget may still spend.
DETERMINISTIC_BRIDGE_FAILURES = (BridgeContractRefused, BridgeContractViolation)


__all__ = [
    "BridgeContractRefused",
    "BridgeContractViolation",
    "DETERMINISTIC_BRIDGE_FAILURES",
]
