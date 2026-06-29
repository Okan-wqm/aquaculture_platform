"""Bridge between plan_convergence and bound-agent envelopes (Plan 016 Faz D2).

Why: `plan_convergence.py` (~1391 lines) ships the primary/challenger
cross-review state machine. Plan 016 wants every planner round to
flow through the strict aria/agent-request/v1 envelope so the lease
lifecycle, separation-of-duties, satisfaction matrix, and recursive
impact graph all attach to the same request_id. This module is the
adapter — it does not replace plan_convergence's logic; it extends
the entry point so a single CLI call (a) records the plan in
plan_convergence and (b) issues the matching envelope to the
maintenance planner queue for an external orchestrator (Claude
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


def start_convergent_plan_drafted_by_primary(
    *,
    plan_id: str,
    plan_content: dict[str, Any],
    initial_revision_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V8 v2 §4 Phase 8.1 (B-V2-07) — open a plan WITHOUT a primary envelope.

    The plan_content supplied here IS the primary's draft (V7.1 cycle_runner
    synthesized it from real git diff). Round-1 no longer mints a primary
    envelope (legacy plan-bootstrap entry was deleted in V8 per B-V2-07:
    CLAUDE.md "no compat shims"). The drainer mints challenger + cross_review
    envelopes immediately; round-2+ mints the primary REVISION envelope via
    ``cross_review_bridge.issue_primary_envelope`` only after state advances
    to CROSS_REVIEWED.

    Returns the plan ledger row only (no primary_request key).
    """
    if not isinstance(plan_content, dict) or not plan_content:
        raise GovernanceError("plan_content is required and must be a non-empty dict")
    plan_row = start_plan(
        plan_id=plan_id,
        plan_content=plan_content,
        initial_revision_id=initial_revision_id,
        base_dir=base_dir,
    )
    return {"plan": plan_row}


def issue_challenger_envelope(
    *,
    plan_id: str,
    round_number: int,
    must_satisfy: list[dict[str, Any]],
    evidence_refs: list[str],
    allowed_scope: list[str],
    suggested_prompt: str = "Independently scan the codebase and write a competing plan from the same evidence.",
    base_dir: str | Path | None = None,
    plan_revision_hash: str | None = None,
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
        plan_revision_hash=plan_revision_hash,
    )
