"""Bridge between plan_convergence and bound-agent envelopes (Plan 016 Faz D2).

Why: `plan_convergence.py` (~1391 lines) ships the primary/challenger
cross-review state machine. Plan 016 wants every planner round to
flow through the strict aria/agent-request/v1 envelope so the lease
lifecycle, separation-of-duties, satisfaction matrix, and recursive
impact graph all attach to the same request_id. This module is the
adapter — it does not replace plan_convergence's logic; it extends
the entry point so a single CLI call (a) records the plan in
plan_convergence and (b) issues the matching envelope to the
maintenance planner queue for an external orchestrator (Codex /
Claude Code session) to claim.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request
from .plan_convergence import start_plan
from .tool_registry import GovernanceError, ensure_tools_dir


PLANNER_ROLES = {
    "primary": ("aria-primary-planner", "primary_plan"),
    "challenger": ("aria-challenger-planner", "challenger_plan"),
}


def start_convergent_plan_with_envelope(
    *,
    plan_id: str,
    plan_content: dict[str, Any],
    initial_revision_id: str,
    must_satisfy: list[dict[str, Any]],
    evidence_refs: list[str],
    allowed_scope: list[str],
    base_dir: str | Path | None = None,
    suggested_prompt: str = "Draft an architecture-first convergent plan.",
) -> dict[str, Any]:
    """Open a plan in plan_convergence AND issue the primary planner envelope.

    Returns the merged record so the caller has both the plan ledger row
    and the request_id the queue uses to track the planner submission.
    """
    if not isinstance(must_satisfy, list) or not must_satisfy:
        raise GovernanceError("must_satisfy is required and must be non-empty")
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise GovernanceError("evidence_refs is required and must be non-empty")
    if not isinstance(allowed_scope, list) or not allowed_scope:
        raise GovernanceError("allowed_scope is required and must be non-empty")

    plan_row = start_plan(
        plan_id=plan_id,
        plan_content=plan_content,
        initial_revision_id=initial_revision_id,
        base_dir=base_dir,
    )

    target_agent, role = PLANNER_ROLES["primary"]
    # Plan 024 §B-2 — forward must_satisfy / allowed_scope / evidence_refs
    # to the request row so the strict path reads them back at claim time
    # instead of seeing empty defaults.
    request = create_agent_invocation_request(
        target_agent=target_agent,
        role=role,
        suggested_prompt=suggested_prompt,
        must_satisfy=must_satisfy,
        allowed_scope=allowed_scope,
        evidence_refs=evidence_refs,
        convergence_id=plan_id,
        round_number=1,
        base_dir=base_dir,
    )
    return {
        "plan": plan_row,
        "primary_request": request,
    }


def issue_challenger_envelope(
    *,
    plan_id: str,
    round_number: int,
    must_satisfy: list[dict[str, Any]],
    evidence_refs: list[str],
    allowed_scope: list[str],
    suggested_prompt: str = "Independently scan the codebase and write a competing plan from the same evidence.",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Issue the challenger planner envelope for a given convergence round.

    Plan 016 separation: operator/orchestrator preserves the
    "challenger reads evidence in independent order, never sees primary
    plan first" discipline Plan 016 §Convergent planning demands.

    Plan 024 §B-2 — must_satisfy / allowed_scope / evidence_refs are
    now required parameters and forwarded to the request row. Same
    bounding-box criteria the primary planner faced; the challenger
    independently checks the same box.
    """
    if not isinstance(must_satisfy, list) or not must_satisfy:
        raise GovernanceError("must_satisfy is required and must be non-empty")
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise GovernanceError("evidence_refs is required and must be non-empty")
    if not isinstance(allowed_scope, list) or not allowed_scope:
        raise GovernanceError("allowed_scope is required and must be non-empty")
    target_agent, role = PLANNER_ROLES["challenger"]
    return create_agent_invocation_request(
        target_agent=target_agent,
        role=role,
        suggested_prompt=suggested_prompt,
        must_satisfy=must_satisfy,
        allowed_scope=allowed_scope,
        evidence_refs=evidence_refs,
        convergence_id=plan_id,
        round_number=round_number,
        base_dir=base_dir,
    )
