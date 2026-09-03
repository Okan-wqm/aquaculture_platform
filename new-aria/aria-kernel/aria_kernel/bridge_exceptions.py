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
"""
from __future__ import annotations

from .tool_registry import GovernanceError


class BridgeContractViolation(GovernanceError):
    """Bridge-side detection of a structural contract violation.

    Caller MUST re-raise this exception explicitly — do NOT swallow
    into agent_bridge_warning. Indicates the producer (round dispatch,
    envelope mint, role mapping) violated a load-bearing contract.
    """
