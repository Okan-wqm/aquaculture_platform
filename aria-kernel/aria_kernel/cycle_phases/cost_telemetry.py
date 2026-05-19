"""Plan ARIA-V3.1-0 — CostTelemetryHook Protocol (V3.1-D consumes).

V10.4 introduced `record_cost_attribution` in `aria-tools/cost-
attribution/<YYYY-MM>.jsonl` but the orchestrator never threaded
invocation_role + cycle_id + envelope.metadata into call sites. v3.1-D
wires the producer side so every LLM call (Primary Plan, Challenger
Plan, Cross-Review, Implementation, V9 specialist) records a cost row
attributing to:

* ``cycle_id``
* ``plan_id``
* ``invocation_role`` (primary_plan / challenger_plan / cross_review /
  implementation / specialist_review)
* ``pressure_source_type`` (threaded from envelope.metadata, NOT from
  plan_content per V3.1-A-1)
* ``signer_key_fp`` (cycle's ephemeral key; defense-in-depth H-5)

V3.1-0 ships ONLY the Protocol + NoOp variant; the real hook lands
in V3.1-D.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping, Protocol

if TYPE_CHECKING:  # pragma: no cover
    pass


@dataclass(frozen=True)
class CostAttributionEnvelope:
    """V3.1-D — typed payload threaded from LLM call site to cost row.

    Fields:

    * ``invocation_role`` — primary_plan / challenger_plan /
      cross_review / implementation / specialist_review
    * ``model`` — Anthropic model id (e.g. ``claude-opus-4-7``)
    * ``input_tokens`` — usage block (operator-side may flag drift)
    * ``output_tokens`` — usage block
    * ``estimated_usd`` — pricing model output (orchestrator computes)
    * ``pressure_source_type`` — threaded from CyclePlanEnvelope.metadata
    * ``signer_key_fp`` — cycle's ephemeral ed25519 fingerprint (V3.1-B
      mints; V3.1-D records). When the cycle has no signing key
      (NoOp/non-autonomous), this is ``"SHA256:no-key"`` sentinel so
      the schema invariant (signer_key_fp starts with ``SHA256:``)
      remains stable.
    """

    invocation_role: str
    model: str
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    pressure_source_type: str
    signer_key_fp: str


class CostTelemetryHook(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for per-LLM cost row.

    Called after every LLM call inside a cycle. Returns the path
    written for the cycle summary; orchestrator does not consume the
    return value further.
    """

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        base_dir: Path,
        envelope: CostAttributionEnvelope,
    ) -> Path | None:
        ...


class NoOpCostTelemetryHook:
    """Plan ARIA-V3.1-0 — default. Returns None so the orchestrator's
    V8 behavior (no per-LLM cost attribution row) is preserved when
    injection is absent.

    Existing cost ledger surfaces (`cost_budget`, `cost_telemetry`
    legacy) are unaffected; this hook is additive.
    """

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        base_dir: Path,
        envelope: CostAttributionEnvelope,
    ) -> Path | None:
        return None


__all__ = [
    "CostAttributionEnvelope",
    "CostTelemetryHook",
    "NoOpCostTelemetryHook",
]
