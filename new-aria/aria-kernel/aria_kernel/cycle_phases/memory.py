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

# Confidence for a convention recorded from a CONVERGED plan, before any
# outcome exists. Deliberately below knowledge_graph.MIN_PATTERN_CONFIDENCE
# (0.7), which is the floor `lookup_pattern` serves from: a pre-outcome
# claim must be recorded and must NOT be handed to the next planner as
# established knowledge. Above 0.0 because convergence is real evidence —
# a planner, a challenger and a cross-review agreed — just evidence about
# agreement rather than about outcome.
CONVENTION_HYPOTHESIS_CONFIDENCE: float = 0.5

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


class MemoryHookImpl:
    """Plan ARIA-V3.1-C2 — production MemoryHook variant (closes V10
    memory pillar activation per cycle).

    Pipeline (Tier-1 ordering per V3.1-C HIGH-005):

      1. Bounded governance read — read_governance_rows_reverse with
         kind_filter=("convergence_resolved", "pattern_signature_observed")
         + limit=200, scaling with the requested limit not the ledger
         size (closes V3.1-C C-12).

      2. Stability check BEFORE record_convention — the cycle's own
         convention row MUST NOT influence its own stability check
         (closes V3.1-C HIGH-005 order swap). The check requires:
            * matching_cycles >= 5
            * distinct_pressure_source_types >= 2
            * distinct_cross_reviewer_agent_ids >= 2
            * OPERATOR_FEEDBACK ∈ distinct_sources (V3.1-C-4 anchor)

      3. record_convention if pattern_signature is non-empty — the
         convention row is the cycle's contribution to the
         knowledge graph (V9.0-F lock-safe write via V3.1-P-3).

      4. verify_chain_or_quarantine AFTER record — Tier-3 detect
         (closes V3.1-C MEDIUM-012). The V3.1-P-3 lock guarantees
         the chain construction is race-free at the syscall level;
         this post-record verify catches any drift detected at
         consumption side.

      5. Skill genesis dispatch ONLY if stability fires AND
         OPERATOR_FEEDBACK present — request_human_required with
         reason='skill_genesis_adapter_authoring' so the operator
         reviews the adapter PR BEFORE activation. NO direct write
         to aria-tools/registry.json (closes V3.1-C ai-safety HIGH-005).

    Frozen / observe profile: this hook IS NOT INVOKED by the
    orchestrator (the orchestrator's profile_announce_allowed gate
    blocks the post-CONVERGED phase under those profiles). Standard
    / strict / autonomous all run the full pipeline.
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
        from ..governance_reader import read_governance_rows_reverse
        from ..knowledge_graph import (
            KNOWLEDGE_GRAPH_SCHEMA_VERSION, Pattern,
            record_convention, verify_chain_or_quarantine,
        )
        from ..plan_synthesizer import compute_pattern_signature
        from ..skill_genesis_drainer import check_pattern_signature_stability
        from ..tool_registry import append_tools_governance
        from datetime import datetime, timezone

        plan_content = dict(converged_plan or {})
        pattern_signature = compute_pattern_signature(plan_content) or ""

        # Phase 1 — bounded governance read (scales with limit, not
        # total ledger size).
        rows = read_governance_rows_reverse(
            base_dir=base_dir, limit=200,
            kind_filter=(
                "convergence_resolved",
                "pattern_signature_observed",
            ),
        )

        # Phase 2 — stability check BEFORE record_convention.
        stability_result = {"stable": False, "reason": "no_pattern_signature"}
        if pattern_signature:
            stability_result = check_pattern_signature_stability(
                pattern_signature=pattern_signature,
                governance_rows=rows,
            )

        # Phase 3 — record_convention (only when pattern_signature
        # is non-empty AND signer_key_fp is the cycle's ephemeral key).
        convention_recorded = False
        convention_path: Path | None = None
        if pattern_signature and signer_key_fp and signer_key_fp.startswith("SHA256:"):
            pattern_id = f"conv_{cycle_id}_{pattern_signature[:16]}"
            pattern = Pattern(
                pattern_id=pattern_id,
                pattern_type="convention",
                # A plan that CONVERGED is not a plan that WORKED. This row
                # is written when the convergent gate resolves — before the
                # change is merged, before CI has run against it, before any
                # outcome exists. It used to be recorded at 0.9, above
                # MIN_PATTERN_CONFIDENCE (0.7), so `lookup_pattern` served it
                # to the next planner as established knowledge: ARIA teaching
                # itself its own predictions as facts.
                #
                # Convergence IS evidence — a planner, a challenger and a
                # cross-review agreed — but evidence about agreement, not
                # about outcome. The row is still recorded, because the
                # observation is worth keeping; it is recorded BELOW the
                # serving floor so it is not handed forward as known.
                # Promotion on a VERIFIED outcome is Wave 10's half.
                confidence=CONVENTION_HYPOTHESIS_CONFIDENCE,
                outcome_status="hypothesis",
                # M2/E12 — the promotion key: the merge reconciler finds
                # this row by plan_id when the plan's PR actually merges
                # (the VERIFIED outcome the comment above promises).
                plan_id=plan_id,
                evidence_refs=tuple(
                    plan_content.get("evidence_refs") or ()
                ),
                discovered_by_cycle_id=cycle_id,
                observed_at=datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                ),
                schema_version=KNOWLEDGE_GRAPH_SCHEMA_VERSION,
            )
            try:
                convention_path = record_convention(
                    pattern,
                    workspace_root=workspace_root,
                    signer_key_fp=signer_key_fp,
                )
                convention_recorded = True
                append_tools_governance(
                    base_dir, "convention_recorded",
                    {
                        "cycle_id": cycle_id, "plan_id": plan_id,
                        "pattern_id": pattern_id,
                        "pattern_signature": pattern_signature,
                    },
                    bypass_profile_gate=True,
                )
            except Exception as exc:
                append_tools_governance(
                    base_dir, "convention_record_failed",
                    {
                        "cycle_id": cycle_id, "plan_id": plan_id,
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:500],
                    },
                    bypass_profile_gate=True,
                )

        # Phase 4 — verify_chain_or_quarantine AFTER record.
        chain_verified = True
        if convention_path is not None:
            try:
                ok, _broken = verify_chain_or_quarantine(convention_path)
                chain_verified = bool(ok)
                if not ok:
                    append_tools_governance(
                        base_dir, "knowledge_graph_quarantined",
                        {
                            "cycle_id": cycle_id, "plan_id": plan_id,
                            "ledger_path": str(convention_path),
                            "broken_at_line": _broken,
                        },
                        bypass_profile_gate=True,
                    )
            except Exception:
                chain_verified = False

        # Phase 5 — skill genesis dispatch ONLY if stability fires.
        skill_genesis_dispatched = False
        skill_genesis_request_id: str | None = None
        if stability_result.get("stable") is True:
            from ..human_required import record_human_required
            skill_genesis_request_id = (
                f"skill-genesis-{cycle_id}-{pattern_signature[:16]}"
            )
            try:
                record_human_required(
                    request_id=skill_genesis_request_id,
                    severity="medium",
                    reason="skill_genesis_adapter_authoring",
                    base_dir=base_dir,
                )
                skill_genesis_dispatched = True
                append_tools_governance(
                    base_dir, "skill_genesis_human_required_dispatched",
                    {
                        "cycle_id": cycle_id, "plan_id": plan_id,
                        "pattern_signature": pattern_signature,
                        "request_id": skill_genesis_request_id,
                        "matching_cycles_count": len(
                            stability_result.get("matching_cycles", [])
                        ),
                    },
                    bypass_profile_gate=True,
                )
            except Exception as exc:
                append_tools_governance(
                    base_dir, "skill_genesis_human_required_failed",
                    {
                        "cycle_id": cycle_id, "plan_id": plan_id,
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:500],
                    },
                    bypass_profile_gate=True,
                )

        return {
            "status": "memory_hook_recorded",
            "pattern_signature": pattern_signature,
            "stability_result": stability_result,
            "convention_recorded": convention_recorded,
            "chain_verified": chain_verified,
            "skill_genesis_dispatched": skill_genesis_dispatched,
            "skill_genesis_request_id": skill_genesis_request_id,
            "rows_scanned": len(rows),
        }


def select_memory_hook(*, profile: str) -> MemoryHook:
    """Plan ARIA-V3.1-C2 — profile-derived MemoryHook factory.

    Mirrors select_auto_merge_runner / select_v9_implementation_runner
    factory pattern. observe + frozen profiles return NoOp because
    the orchestrator's post-CONVERGED hook is itself
    profile-announce-gated; the factory just shadows the orchestrator
    contract.
    """
    if profile in ("observe", "frozen"):
        return NoOpMemoryHook()
    return MemoryHookImpl()


__all__ = [
    "MemoryHook",
    "MemoryHookImpl",
    "NoOpMemoryHook",
    "select_memory_hook",
]
