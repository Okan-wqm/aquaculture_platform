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
from .request_admission import Admission
from .plan_contract import render_plan_contract, require_plan_contract
from .plan_convergence import _planning_source_context, fold_plan_state, start_plan
from .plan_round_scope import plan_round_contract
from .planner_lessons import planner_lesson_obligations
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
    workspace_root: str | Path | None = None,
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

    ``workspace_root`` is where ``start_plan`` computes a finding-origin
    plan's admission bound (ADR-0021).
    """
    if not isinstance(plan_content, dict) or not plan_content:
        raise GovernanceError("plan_content is required and must be a non-empty dict")
    # ARIA-HIGH-104 (1) — the seed's validation commands must already be ones
    # the plan contract admits. Every planning envelope minted on this plan
    # derives its `validation_commands` from the revision it names, and the
    # `plan_contract_complete` gate refuses the body at CONVERGED anyway: a
    # seed carrying an undeclared command could start rounds no planner could
    # converge. Refused here, before the plan is opened, in the contract's
    # own wording — the tier is not required of a seed (`require_tier=False`).
    require_plan_contract(plan_content, base_dir=base_dir, require_tier=False)
    plan_row = start_plan(
        plan_id=plan_id,
        plan_content=plan_content,
        initial_revision_id=initial_revision_id,
        base_dir=base_dir,
        workspace_root=workspace_root,
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
    target_sha: str | None = None,
    context_repo_root: str | Path | None = None,
    cycle_id: str | None = None,
    context_source_paths: list[str] | None = None,
    remint_of: str | None = None,
    admission: Admission,
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
        # ARIA-HIGH-309 — the lessons recorded plans in this plan's scope teach.
        must_satisfy=[*must_satisfy, *planner_lesson_obligations(base_dir=base_dir, plan_id=plan_id)],
        allowed_scope=allowed_scope,
        evidence_refs=evidence_refs,
        convergence_id=plan_id,
        round_number=round_number,
        base_dir=base_dir,
        plan_revision_hash=plan_revision_hash,
        target_sha=target_sha,
        context_repo_root=context_repo_root,
        cycle_id=cycle_id,
        context_source_paths=context_source_paths,
        # What the challenger's plan body must carry to be accepted and to
        # converge, rendered from this store — the rule and the refusal
        # read the same function.
        plan_contract=render_plan_contract(base_dir),
        # ARIA-HIGH-355 — the step's dead or refused request this one replaces.
        remint_of=remint_of,
        # ARIA-HIGH-364 — the producer's admission decision, carried to the mint.
        admission=admission,
    )


def start_convergent_plan_with_challenger(
    *,
    plan_id: str,
    plan_content: dict[str, Any],
    initial_revision_id: str,
    operator_must_satisfy: list[dict[str, Any]],
    admission: Admission,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """ARIA-MEDIUM-376 — the operator's one call: open the plan, then mint its round-1 challenger.

    WHY. ``aria-kernel convergent-plan`` imported the legacy start-with-
    envelope entry V8 deleted (B-V2-07: the plan content IS the primary's
    draft, so round 1 mints no primary; I-V8.1-02 pins that it stays gone).
    The import failed, so neither ``start`` nor ``issue-challenger`` could
    run, and the operator had no path into the convergent loop outside a
    cycle.

    WHAT. The V8 shape the convergence drainer's seed branch runs, through
    the same two primitives: ``start_convergent_plan_drafted_by_primary``,
    then ``issue_challenger_envelope`` for round 1. The round's scope,
    obligations and evidence are derived from the plan's own
    ``plan_started`` record (``plan_round_contract``, ARIA-HIGH-345), never
    from the caller; the operator's obligations are added to them.
    """
    from .convergence_drainer import _resolve_workspace_head_sha

    started = start_convergent_plan_drafted_by_primary(
        plan_id=plan_id,
        plan_content=plan_content,
        initial_revision_id=initial_revision_id,
        base_dir=base_dir,
        workspace_root=workspace_root,
    )
    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    contract = plan_round_contract(state)
    refs, revision_hash, context_paths = _planning_source_context(state, list(contract.evidence_refs))
    challenger = issue_challenger_envelope(
        plan_id=plan_id,
        round_number=1,
        must_satisfy=[*contract.must_satisfy, *operator_must_satisfy],
        evidence_refs=refs,
        allowed_scope=list(contract.allowed_scope),
        base_dir=base_dir,
        plan_revision_hash=revision_hash,
        target_sha=_resolve_workspace_head_sha(workspace_root),
        context_repo_root=workspace_root,
        context_source_paths=context_paths,
        admission=admission,
    )
    return {"plan": started["plan"], "challenger_request": challenger}
