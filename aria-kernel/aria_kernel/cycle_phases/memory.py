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

# Bounds attempts per callback, not history scans, latency, or key lifetime.
PENDING_OBSERVATION_ATTEMPT_LIMIT: int = 8

if TYPE_CHECKING:  # pragma: no cover
    from ..knowledge_graph import Pattern


def _convention_pattern(
    *, cycle_id: str, plan_id: str, plan_content: Mapping[str, Any], pattern_signature: str,
) -> Pattern:
    from datetime import datetime, timezone
    from ..knowledge_graph import KNOWLEDGE_GRAPH_SCHEMA_VERSION, Pattern

    # Reviewed convergence supports a hypothesis, not measured improvement.
    # Keep original discovery identity across later signer lifetimes. Promotion
    # and outcome qualification remain their existing owners' responsibility.
    return Pattern(
        pattern_id=f"conv_{cycle_id}_{pattern_signature[:16]}",
        pattern_type="convention", confidence=CONVENTION_HYPOTHESIS_CONFIDENCE,
        outcome_status="hypothesis", plan_id=plan_id,
        evidence_refs=tuple(plan_content.get("evidence_refs") or ()),
        discovered_by_cycle_id=cycle_id,
        observed_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        schema_version=KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    )


def _record_convention_observation(
    *, cycle_id: str, plan_id: str, plan_content: Mapping[str, Any],
    pattern_signature: str, signer_key_fp: str,
    base_dir: Path, workspace_root: Path | None = None,
    operation_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append and verify one hypothesis; preserve direct-hook audit semantics."""
    from ..knowledge_graph import record_convention, verify_chain_or_quarantine
    from ..tool_registry import append_tools_governance

    convention_recorded = False
    convention_path: Path | None = None
    convention_status = "no_pattern_signature"
    result = operation_report if operation_report is not None else {}
    result.update({"status": convention_status, "convention_recorded": False, "chain_verified": None})
    provenance = {key: result[key] for key in (
        "plan_revision_id", "plan_content_hash", "signer_cycle_id", "signer_key_fp",
        "pending_event_hash", "convergence_event_id", "convergence_event_hash",
    ) if key in result}
    if pattern_signature and signer_key_fp is not None:
        pattern = _convention_pattern(
            cycle_id=cycle_id, plan_id=plan_id, plan_content=plan_content,
            pattern_signature=pattern_signature,
        )
        pattern_id = pattern.pattern_id
        try:
            convention_path = record_convention(
                pattern,
                workspace_root=workspace_root,
                base_dir=base_dir,
                signer_key_fp=signer_key_fp,
            )
            convention_recorded = True
            convention_status = "memory_hook_recorded"
            # The caller must retain the known append outcome even if both
            # audit attempts fail and the direct hook propagates that failure.
            result.update({"status": convention_status, "convention_recorded": True})
            append_tools_governance(
                base_dir, "convention_recorded",
                {
                    "cycle_id": cycle_id, "plan_id": plan_id,
                    "pattern_id": pattern_id,
                    "pattern_signature": pattern_signature, **provenance,
                },
                bypass_profile_gate=True,
            )
        except Exception as exc:
            convention_status = (
                "convention_audit_failed" if convention_recorded
                else "convention_record_failed"
            )
            result.update({"status": convention_status, "error_class": type(exc).__name__})
            if convention_recorded:
                result["audit_error_class"] = type(exc).__name__
            try:
                append_tools_governance(
                    base_dir, convention_status,
                    {
                        "cycle_id": cycle_id, "plan_id": plan_id,
                        "error_class": type(exc).__name__, **provenance,
                    },
                    bypass_profile_gate=True,
                )
            except Exception as audit_exc:
                result["audit_error_class"] = type(audit_exc).__name__
                raise

    # Phase 4 — verify_chain_or_quarantine AFTER record.
    chain_verified: bool | None = None
    if convention_path is not None:
        try:
            ok, _broken = verify_chain_or_quarantine(convention_path)
            chain_verified = bool(ok)
            if not ok:
                convention_status = "convention_chain_invalid"
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
            convention_status = "convention_chain_invalid"

    result.update({
        "status": convention_status,
        "convention_recorded": convention_recorded,
        "chain_verified": chain_verified,
    })
    return result


class MemoryHook(Protocol):
    """Plan ARIA-V3.1-0 — injection-seam contract for KG record + skill genesis.

    Called after `convergence_resolved` when `arbiter_verdict ==
    "converged"`. Returns a summary dict for the cycle summary +
    governance event. The implementation reads the reviewed plan body
    from its owning ledger, using plan_id; callers supply no copy.
    """

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        plan_envelope_metadata: Mapping[str, Any],
        profile: str,
        signer_key_fp: str | None,
    ) -> dict[str, Any]:
        ...

    def complete_pending_observations(
        self, *, base_dir: Path, signer_cycle_id: str, signer_key_fp: str,
        report: dict[str, Any],
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

    def complete_pending_observations(
        self, *, base_dir: Path, signer_cycle_id: str, signer_key_fp: str,
        report: dict[str, Any],
    ) -> dict[str, Any]:
        return {"status": "no_op_memory_hook", "observations": []}


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

      3. record_convention if pattern_signature and a signer are present.
         Without the cycle signer, record a needs_signing observation
         with the canonical plan revision and hash; no convention is written.

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
    / strict / autonomous run the hook; convention writing still requires
    its signer.
    """

    def complete_pending_observations(
        self, *, base_dir: Path, signer_cycle_id: str, signer_key_fp: str,
        report: dict[str, Any],
    ) -> dict[str, Any]:
        """Complete original observations while the caller owns its signer.

        Scheduling is derived from verified governance append order. A durable
        attempt moves a failing item behind older waiters; a later arrival
        cannot continually overtake them. The cap bounds attempts only. Source
        and knowledge lookups may still scan the full history, and no ledger
        transaction is held across another owner's operation.
        """
        from ..knowledge_graph import _has_recorded_convention
        from ..ledger import load_declared_jsonl
        from ..plan_convergence import resolve_converged_plan_observation
        from ..plan_synthesizer import compute_pattern_signature
        from ..tool_registry import GovernanceError, append_tools_governance, tools_dir

        rows = load_declared_jsonl(tools_dir(base_dir) / "governance.jsonl", expected_surface="tools_governance")
        report.update({"status": "completed", "observations": [], "attempted": 0, "already_recorded": 0})
        pending_by_claim: dict[tuple[str, ...], tuple[int, dict[str, Any]]] = {}
        last_attempt: dict[str, int] = {}
        for ordinal, row in enumerate(rows):
            if row.get("kind") == "convention_observation_attempted":
                last_attempt[row["details"]["pending_event_hash"]] = ordinal
            if row.get("kind") != "convention_record_needs_signing":
                continue
            pending = row["details"]
            # Match the existing disclosure's claim keys. Its first verified
            # event owns discovery identity even if a later cycle repeats it.
            claim = tuple(pending[key] for key in (
                "plan_id", "plan_revision_id", "plan_content_hash", "reason",
            ))
            pending_by_claim.setdefault(claim, (ordinal, row))
        candidates = sorted(
            pending_by_claim.values(),
            key=lambda item: (last_attempt.get(item[1]["ledger_hash"], item[0]), item[0]),
        )
        for _ordinal, row in candidates:
            if report["attempted"] >= PENDING_OBSERVATION_ATTEMPT_LIMIT:
                break
            pending = row["details"]
            provenance = {
                "cycle_id": pending["cycle_id"], "plan_id": pending["plan_id"],
                "plan_revision_id": pending["plan_revision_id"], "plan_content_hash": pending["plan_content_hash"],
                "pattern_signature": pending["pattern_signature"], "pending_event_hash": row["ledger_hash"],
                "signer_cycle_id": signer_cycle_id, "signer_key_fp": signer_key_fp,
            }
            source_error_class: str | None = None
            try:
                body = resolve_converged_plan_observation(
                    plan_id=pending["plan_id"], revision_id=pending["plan_revision_id"],
                    expected_content_hash=pending["plan_content_hash"], base_dir=base_dir,
                )
                signature = compute_pattern_signature(body["plan_content"])
                if not signature or signature != pending["pattern_signature"]:
                    raise GovernanceError("pending_observation_source_mismatch")
                provenance.update({
                    "convergence_event_id": body["convergence_event_id"],
                    "convergence_event_hash": body["convergence_event_hash"],
                })
                pattern = _convention_pattern(
                    cycle_id=pending["cycle_id"], plan_id=pending["plan_id"],
                    plan_content=body["plan_content"], pattern_signature=signature,
                )
                if _has_recorded_convention(pattern, base_dir=base_dir):
                    report["already_recorded"] += 1
                    report["observations"].append({
                        **provenance, "status": "already_recorded", "convention_recorded": True,
                        "chain_verified": True, "append_attempted": False,
                    })
                    continue
            except Exception as exc:
                source_error_class = type(exc).__name__

            observation = {
                **provenance, "status": "pending", "convention_recorded": False, "chain_verified": None,
                "append_attempted": False,
            }
            report["observations"].append(observation)
            # Persist scheduling progress before attempting the observation.
            # An unavailable audit must not cause an unaudited knowledge write.
            try:
                append_tools_governance(base_dir, "convention_observation_attempted", provenance)
            except Exception as exc:
                observation.update({"status": "attempt_audit_failed", "audit_error_class": type(exc).__name__})
                report.update({"status": "audit_error", "audit_error_class": type(exc).__name__})
                break
            report["attempted"] += 1
            if source_error_class is not None:
                observation.update({"status": "observation_source_failed", "error_class": source_error_class})
                report["status"] = "completed_with_errors"
                try:
                    append_tools_governance(base_dir, "convention_observation_failed", {
                        **provenance, "error_class": source_error_class,
                    })
                except Exception as exc:
                    observation["audit_error_class"] = type(exc).__name__
                continue
            try:
                observation["append_attempted"] = True
                _record_convention_observation(
                    cycle_id=pending["cycle_id"], plan_id=pending["plan_id"],
                    plan_content=body["plan_content"], pattern_signature=signature,
                    signer_key_fp=signer_key_fp, base_dir=base_dir,
                    operation_report=observation,
                )
            except Exception as exc:
                # The shared operation publishes its append outcome before
                # audit writes; retain that truth if reporting itself fails.
                observation.setdefault("error_class", type(exc).__name__)
            if observation.get("error_class") or observation.get("chain_verified") is False:
                report["status"] = "completed_with_errors"
        return report

    def record(
        self,
        *,
        cycle_id: str,
        plan_id: str,
        workspace_root: Path,
        base_dir: Path,
        plan_envelope_metadata: Mapping[str, Any],
        profile: str,
        signer_key_fp: str | None,
    ) -> dict[str, Any]:
        from ..governance_reader import read_governance_rows_reverse
        from ..plan_synthesizer import compute_pattern_signature
        from ..plan_convergence import fold_plan_state, plan_body_from_state
        from ..skill_genesis_drainer import check_pattern_signature_stability
        from ..tool_registry import (
            GovernanceError, append_tools_governance, append_tools_governance_once,
        )

        # The plan ledger owns both convergence and its reviewed body. A
        # caller-supplied copy can be absent or name a different revision.
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        if state.get("state") != "CONVERGED":
            raise GovernanceError(
                f"memory_requires_converged_plan: plan_id={plan_id!r} "
                f"is in state {state.get('state')!r}"
            )
        body = plan_body_from_state(state)
        plan_content = body["plan_content"]
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
        convention_status = "no_pattern_signature"
        if pattern_signature and signer_key_fp is None:
            convention_status = "needs_signing"
            append_tools_governance_once(
                base_dir, "convention_record_needs_signing",
                {
                    "cycle_id": cycle_id,
                    "plan_id": plan_id,
                    "plan_revision_id": body["revision_id"],
                    "plan_content_hash": body["content_hash"],
                    "pattern_signature": pattern_signature,
                    "reason": "cycle_signer_unavailable",
                    "convention_recorded": False,
                },
                claim_keys=("plan_id", "plan_revision_id", "plan_content_hash", "reason"),
            )
        observation = {"status": convention_status, "convention_recorded": False, "chain_verified": None}
        if pattern_signature and signer_key_fp is not None:
            observation = _record_convention_observation(
                cycle_id=cycle_id, plan_id=plan_id, plan_content=plan_content,
                pattern_signature=pattern_signature, signer_key_fp=signer_key_fp,
                base_dir=base_dir, workspace_root=workspace_root,
            )

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
            "status": observation["status"],
            "plan_revision_id": body["revision_id"],
            "plan_content_hash": body["content_hash"],
            "pattern_signature": pattern_signature,
            "stability_result": stability_result,
            "convention_recorded": observation["convention_recorded"],
            "chain_verified": observation["chain_verified"],
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
