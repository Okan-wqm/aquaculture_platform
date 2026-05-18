"""Plan 026R §C.1 — planner-role auto-bridge for submit_claim_result.

Pre-§C.1 ``judgment_bridge.record_judge_verdict_from_response`` and
``persist_supporting_payload`` covered:

* JUDGE_ROLES = ("evidence_judgment", "adversarial_judgment",
  "consensus_arbitration")
* SUPPORTING_ROLES = ("change_intelligence", "goldset_curation")

Planner-class roles (``primary_plan``, ``challenger_plan``,
``cross_review``) fell THROUGH the bridge silently — an accepted
planner submission landed on results.jsonl but the convergent-
planning ledger (plan_convergence_events.jsonl + downstream state
machine) never saw it. ci_executor + worker flows that watched the
planner pipeline for round-completion signals stalled because the
ledger row was never appended.

§C.1 closes the gap with a dedicated bridge that dispatches by role:

* ``primary_plan`` → ``plan_convergence.record_revision`` — the
  primary planner's submission IS the revision.
* ``challenger_plan`` → ``plan_convergence.submit_challenger_plan``
  — the challenger's parallel plan enters the round.
* ``cross_review`` → ``plan_convergence.record_cross_review`` — the
  bidirectional cross-review verdict gets recorded.

Idempotency: each ``plan_convergence`` mutation uses an
``idempotency_key`` derived from ``plan_id + command + canonical
payload``, so re-invoking the bridge on the same envelope produces
the same event_id WITHOUT duplicating the event row.

Error handling mirrors ``judgment_bridge``: GovernanceError + import
failures become ``agent_bridge_warning`` governance events with
``kind="plan_convergence_bridge"`` and do NOT undo the accept. The
response already passed every gate; downstream wiring shortfalls are
operator-tracked actions, not silent re-rejections.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


PLANNER_BRIDGE_ROLES: frozenset[str] = frozenset({
    "primary_plan",
    "challenger_plan",
    "cross_review",
})


def is_planner_bridge_role(role: str | None) -> bool:
    return role in PLANNER_BRIDGE_ROLES


def _extract_plan_id(request: dict[str, Any], response: dict[str, Any]) -> str | None:
    """Resolve the convergent-plan id from either the request envelope
    (preferred — the planner request row carries it) or the response
    envelope (legacy fallback)."""
    plan_id = request.get("plan_id") or request.get("convergence_id")
    if plan_id:
        return str(plan_id)
    details = response.get("details") or {}
    if isinstance(details, dict):
        candidate = details.get("plan_id") or details.get("convergence_id")
        if candidate:
            return str(candidate)
    return None


# Plan ARIA-V8 v2 §4 Phase 8.2 (B-V2-06 + B-V2-09 + architect I1)
# — declarative state dispatch for primary_plan.
#
# WHY a literal dict instead of if/elif: the table is the source of
# truth + the source-substring invariant pins on `_PRIMARY_PLAN_STATE_DISPATCH`
# (real load-bearing constant, not invariant theater per architect B-V2-04).
# Adding a new legal state for primary submission = one table entry.
# Removing a state = one table entry. Future maintainers cannot drift.
#
# Why DRAFT is NOT in the table: V8's cross_review_bridge.issue_primary_envelope
# (C3) refuses to mint primary envelopes on DRAFT state — the bridge here
# is defense-in-depth. If somehow an illegal primary envelope reaches the
# bridge, BridgeContractViolation is raised (caught + re-raised by
# agent_invocations wrapper, NOT swallowed into agent_bridge_warning).
_PRIMARY_PLAN_STATE_DISPATCH: dict[str, str] = {
    "CRITIQUED": "record_revision",
    "CROSS_REVIEWED": "record_revision",
}


def record_plan_result(
    *,
    role: str | None,
    request: dict[str, Any],
    response: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Plan 026R §C.1 (V8 v2 §4 Phase 8.2 — state-aware primary dispatch).

    Returns:
        ``None`` when ``role`` is not a planner bridge role (no-op for
        judge / supporting flows — judgment_bridge handles those).
        The persisted event dict when the dispatch succeeded.

    Raises:
        ``BridgeContractViolation`` when role=primary_plan arrives on a
        state outside ``_PRIMARY_PLAN_STATE_DISPATCH``. The caller at
        ``agent_invocations._submit_legacy_invocation_result_internal``
        RE-RAISES this subclass (vs the generic GovernanceError path
        that gets swallowed into agent_bridge_warning).
        ``GovernanceError`` on other schema / state errors so the
        caller's agent_bridge_warning path can record them.
    """
    if role not in PLANNER_BRIDGE_ROLES:
        return None
    # Local imports avoid a kernel cold-start cycle.
    from .bridge_exceptions import BridgeContractViolation
    from .plan_convergence import (
        fold_plan_state,
        record_cross_review,
        record_revision,
        submit_challenger_plan,
    )
    from .tool_registry import GovernanceError

    plan_id = _extract_plan_id(request, response)
    if plan_id is None:
        raise GovernanceError(
            f"plan_convergence_bridge_missing_plan_id: role={role!r} "
            f"request keys={sorted(request.keys())[:8]}"
        )

    details = response.get("details") or {}
    if not isinstance(details, dict):
        details = {}

    if role == "primary_plan":
        # Plan ARIA-V8 v2 §4 Phase 8.2 — state-aware dispatch via
        # _PRIMARY_PLAN_STATE_DISPATCH. Unknown state → BridgeContractViolation.
        state_dict = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        current_state = state_dict.get("state") if isinstance(state_dict, dict) else None
        handler_name = _PRIMARY_PLAN_STATE_DISPATCH.get(str(current_state))
        if handler_name is None:
            raise BridgeContractViolation(
                f"primary_plan_invalid_state: state={current_state} "
                f"plan_id={plan_id} expected one of "
                f"{sorted(_PRIMARY_PLAN_STATE_DISPATCH)}; convergence "
                f"pipeline contract broken — round dispatch in "
                f"convergence_drainer.py minted primary envelope before "
                f"plan reached CRITIQUED or CROSS_REVIEWED"
            )
        if handler_name == "record_revision":
            revision_payload = details.get("revision") or details.get("plan") or details
            return record_revision(
                plan_id=plan_id,
                revision=revision_payload,
                base_dir=base_dir,
            )
        # Defensive: the literal table only contains "record_revision"
        # today. Future entries MUST extend this branch — typing.assert_never
        # would catch a missing handler at mypy time; runtime fallback
        # raises BridgeContractViolation.
        raise BridgeContractViolation(
            f"primary_plan_handler_missing: handler_name={handler_name} "
            f"present in _PRIMARY_PLAN_STATE_DISPATCH but no dispatch arm; "
            f"V8 bridge needs extension"
        )

    if role == "challenger_plan":
        # Plan ARIA-V8.1 — canonical-payload normalization.
        # Agent emits `plan_content` (the substantive deliverable);
        # bridge wraps it with kernel-state-derived envelope metadata
        # (source_revision_id, source_plan_content_hash) so
        # _normalize_challenger_plan -> _validate_plan_content can
        # accept the submission. Pre-V8.1 the bridge passed raw
        # `details` to submit_challenger_plan which always failed at
        # `plan content must be a JSON object` because `details`
        # contained agent metadata, not the canonical plan_content
        # wrapper.
        challenger_payload = _canonicalize_challenger_payload(
            response=response,
            details=details,
            plan_id=plan_id,
            base_dir=base_dir,
        )
        return submit_challenger_plan(
            plan_id=plan_id,
            challenger=challenger_payload,
            base_dir=base_dir,
        )

    # role == "cross_review"
    # Plan ARIA-V8.2 — single-step V8 P+C+CR transition.
    # The V8 architecture mints ONE aria-cross-reviewer envelope per
    # round that bidirectionally compares primary↔challenger. The
    # legacy 3-event kernel flow (request_cross_review → record per
    # task × 2 → CROSS_REVIEWED) is wrapped by submit_cross_review_v8
    # into a single kernel call that synthesizes task metadata from
    # state. Bridge dispatches to it instead of raw record_cross_review.
    from .plan_convergence import submit_cross_review_v8

    review_payload = details.get("review") or details.get("cross_review") or details
    workspace_root = request.get("workspace_root") or response.get("workspace_root") or "."
    # Carry the reviewer_agent into the V8 payload — bridge knows the
    # agent_id from response while record-shaped review may omit it.
    if isinstance(review_payload, dict) and not review_payload.get("reviewer_agent"):
        review_payload = {**review_payload, "reviewer_agent": response.get("agent_id") or "aria-cross-reviewer"}
    return submit_cross_review_v8(
        plan_id=plan_id,
        review=review_payload,
        workspace_root=workspace_root,
        base_dir=base_dir,
    )


def _canonicalize_challenger_payload(
    *,
    response: dict[str, Any],
    details: dict[str, Any],
    plan_id: str,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """Plan ARIA-V8.1 — wrap agent's plan_content in canonical wrapper.

    Returns a dict shaped for ``_normalize_challenger_plan``:
        {
          "challenger_agent": <agent_id>,
          "challenger_revision_id": <derived id>,
          "source_revision_id": <kernel latest revision_id>,
          "source_plan_content_hash": <kernel latest content_hash>,
          "plan_content": <agent's canonical plan_content>,
        }

    Extraction order for plan_content:
      1. details.challenger.plan_content (deep canonical — preferred)
      2. details.plan.plan_content (alt nesting)
      3. response.plan_content (TOP-LEVEL — our V8.1 agent contract)
      4. details.plan_content (semi-canonical)
      5. details (last resort — preserves backward compat)
    Returns whatever shape is present; downstream
    ``_validate_plan_content`` strictly checks the required fields.
    """
    from .plan_convergence import fold_plan_state  # local import; avoid cycle

    plan_content: Any = None
    challenger_block = details.get("challenger")
    if isinstance(challenger_block, dict) and "plan_content" in challenger_block:
        plan_content = challenger_block.get("plan_content")
    if plan_content is None:
        plan_block = details.get("plan")
        if isinstance(plan_block, dict) and "plan_content" in plan_block:
            plan_content = plan_block.get("plan_content")
    if plan_content is None:
        plan_content = response.get("plan_content")
    if plan_content is None:
        plan_content = details.get("plan_content")

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    latest = (state.get("latest_revision") or {}) if isinstance(state, dict) else {}
    source_revision_id = latest.get("revision_id")
    source_hash = latest.get("content_hash")

    # If the agent already supplied a canonical wrapper, prefer its
    # fields where present; fall back to kernel-derived metadata for
    # any that the agent omitted. The wrapper-style envelope (where
    # the agent set source_revision_id explicitly) is still allowed —
    # we only fill in the gaps.
    supplied = challenger_block if isinstance(challenger_block, dict) else {}
    request_id = response.get("request_id") or "unknown"
    return {
        "challenger_agent": supplied.get("challenger_agent") or response.get("agent_id"),
        "challenger_revision_id": supplied.get("challenger_revision_id")
        or f"chal-{plan_id}-{request_id[-12:]}",
        "source_revision_id": supplied.get("source_revision_id") or source_revision_id,
        "source_plan_content_hash": supplied.get("source_plan_content_hash") or source_hash,
        "plan_content": plan_content,
    }


__all__ = [
    "PLANNER_BRIDGE_ROLES",
    "is_planner_bridge_role",
    "record_plan_result",
]
