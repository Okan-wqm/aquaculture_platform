"""Plan ARIA-V3.1-0 — cycle_phases protocol-based DI.

The orchestrator (`autonomy_orchestrator.run_autonomy_orchestrator`)
is the load-bearing center of the V8+V9 pipeline. Plan v3.1-0
introduces Protocol-typed cycle concerns so subsequent phases
(V3.1-A..D) can install real implementations behind a stable
contract without re-touching the orchestrator body.

5 concerns:

* `plan_source.PlanContentProvider` — V9.4 candidate mining + V7
  git-diff fallback (V3.1-A consumes).
* `implementer.V9ImplementationRunner` — V9 implementation-phase
  orchestration (V3.1-B consumes).
* `memory.MemoryHook` — post-CONVERGED KG record + skill genesis
  stability check (V3.1-C consumes).
* `cost_telemetry.CostTelemetryHook` — V10.4 invocation-role
  threading + record_cost_attribution (V3.1-D consumes).
* `profile_gate.ProfileGate` — V9.7 profile + V9.0-C preflight
  (V3.1-E consumes).

Every Protocol has a `NoOp*` default that preserves the V3 baseline
behavior (no new side-effects). The orchestrator accepts each phase
hook as an optional kwarg defaulting to its NoOp variant — a caller
that does not opt in sees the pre-v3.1 cycle exactly.

Tier-1 anchor: Protocol typing makes the contract a compile-time
artifact; a future phase that drops a method becomes a static-type
error rather than a runtime KeyError. The 5 protocol surfaces also
provide the DI seam that integration tests (V3.1-B-10) inject mocks
through.

Cold-start discipline (I-V31-0-01 + I-V31-0-05): every concrete
implementation under this package uses `if TYPE_CHECKING` for
type-only imports and lazy `from .X import Y` inside function bodies
when its dependencies pull network/IO. The orchestrator's top-level
import surface stays ≤ baseline + 1 (only the package re-export).
"""
from __future__ import annotations

from .cost_telemetry import (
    CostAttributionEnvelope,
    CostTelemetryHook,
    NoOpCostTelemetryHook,
)
from .implementer import (
    NoOpV9ImplementationRunner,
    V9ImplementationResult,
    V9ImplementationRunner,
)
from .memory import MemoryHook, NoOpMemoryHook
from .plan_source import (
    CyclePlanEnvelope,
    NoOpPlanContentProvider,
    PlanContentProvider,
)
from .profile_gate import NoOpProfileGate, ProfileGate

__all__ = [
    "CostAttributionEnvelope",
    "CostTelemetryHook",
    "CyclePlanEnvelope",
    "MemoryHook",
    "NoOpCostTelemetryHook",
    "NoOpMemoryHook",
    "NoOpPlanContentProvider",
    "NoOpProfileGate",
    "NoOpV9ImplementationRunner",
    "PlanContentProvider",
    "ProfileGate",
    "V9ImplementationResult",
    "V9ImplementationRunner",
]
