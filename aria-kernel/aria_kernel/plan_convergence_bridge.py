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


def record_plan_result(
    *,
    role: str | None,
    request: dict[str, Any],
    response: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Plan 026R §C.1 — dispatch an accepted planner-role response to
    the correct plan_convergence mutation.

    Returns:
        ``None`` when ``role`` is not a planner bridge role (no-op for
        judge / supporting flows — judgment_bridge handles those).
        The persisted event dict when the dispatch succeeded.

    Raises ``GovernanceError`` on schema / state errors so the caller
    can record an ``agent_bridge_warning`` (mirrors judgment_bridge).
    """
    if role not in PLANNER_BRIDGE_ROLES:
        return None
    # Local imports avoid a kernel cold-start cycle (plan_convergence
    # imports tool_registry which imports ledger; this module is loaded
    # only when a planner role lands).
    from .plan_convergence import (
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
        revision_payload = details.get("revision") or details.get("plan") or details
        return record_revision(
            plan_id=plan_id,
            revision=revision_payload,
            base_dir=base_dir,
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
