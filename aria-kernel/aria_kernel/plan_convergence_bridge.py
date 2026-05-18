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
        challenger_payload = details.get("challenger") or details.get("plan") or details
        return submit_challenger_plan(
            plan_id=plan_id,
            challenger=challenger_payload,
            base_dir=base_dir,
        )

    # role == "cross_review"
    review_payload = details.get("review") or details.get("cross_review") or details
    workspace_root = request.get("workspace_root") or response.get("workspace_root") or "."
    return record_cross_review(
        plan_id=plan_id,
        review=review_payload,
        workspace_root=workspace_root,
        base_dir=base_dir,
    )


__all__ = [
    "PLANNER_BRIDGE_ROLES",
    "is_planner_bridge_role",
    "record_plan_result",
]
