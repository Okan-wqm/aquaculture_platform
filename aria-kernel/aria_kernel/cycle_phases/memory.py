"""Plan ARIA-V3.1-0 — MemoryHook Protocol (V3.1-C consumes).

V10 vision pillar "ARIA learns between cycles". Post-CONVERGED, the
cycle's converged plan_content is fed into the knowledge graph
(`knowledge_graph.record_convention`) and the skill-genesis stability
check (`check_pattern_signature_stability`) fires when N≥5 distinct
cycles agree on a pattern_signature AND OPERATOR_FEEDBACK ∈
distinct_pressure_source_types.

V3.1-C order discipline (closes C-12 + HIGH-005):

  1. Read the existing governance rows via the bounded
     `governance_reader.read_governance_rows_reverse` (Tier-1 bounded
     seek-to-end, O(64KB) regardless of total ledger size).
  2. Check pattern_signature_stability BEFORE recording the cycle's
     OWN convention row (the cycle must NOT influence its own
     stability check).
  3. Record the convention via `knowledge_graph.record_convention`
     (lock-safe per V3.1-P-3).
  4. Verify the post-record chain via
     `verify_chain_or_quarantine` (Tier-3 detect; the lock in step 3
     makes a race structurally impossible per Tier-1).
  5. If stability fires AND OPERATOR_FEEDBACK ∈ distinct_sources,
     dispatch `request_convergent_authoring` via
     `skill_genesis_sandbox.execute_in_sandbox` and register the
     resulting adapter through `human_required.request_human_required`
     (NO direct write to `aria-tools/registry.json`).

V3.1-0 ships ONLY the Protocol + NoOp variant. The real implementation
lands in V3.1-C.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping, Protocol

if TYPE_CHECKING:  # pragma: no cover
    pass


class MemoryHook(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for KG record + skill genesis.

    Called after `convergence_resolved` when `arbiter_verdict ==
    "converged"`. Returns a summary dict for the cycle summary +
    governance event.
    """

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        converged_plan: Mapping[str, Any],
        plan_envelope_metadata: Mapping[str, Any],
        profile: str,
        signer_key_fp: str | None,
    ) -> dict[str, Any]:
        ...


class NoOpMemoryHook:
    """Plan ARIA-V3.1-0 — default. Returns a sentinel dict so the
    orchestrator's V8 post-CONVERGED behavior is preserved exactly
    when injection is absent.

    Specifically: skips `record_convention` + `check_pattern_signature_stability`
    + skill_genesis dispatch. The orchestrator continues to
    `specialist_review` + `review_runner` + `auto_merge_runner` as it
    did pre-v3.1.
    """

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        converged_plan: Mapping[str, Any],
        plan_envelope_metadata: Mapping[str, Any],
        profile: str,
        signer_key_fp: str | None,
    ) -> dict[str, Any]:
        return {
            "status": "no_op_memory_hook",
            "convention_recorded": False,
            "stability_check_fired": False,
            "skill_genesis_dispatched": False,
        }


__all__ = [
    "MemoryHook",
    "NoOpMemoryHook",
]
