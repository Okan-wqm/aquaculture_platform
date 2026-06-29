"""Plan 031 Faz 031e — expert-reviewer consensus gate (evidence-verified).

WHY this module exists
----------------------
The operator cannot be the code-correctness reviewer of an autonomous fix
(they cannot out-review the AI). Their explicit ask: review each fix with
"≥2 independent topic-relevant expert agents, and against their hallucination,
verify the verdicts once more with evidence." This module is exactly that — and
it is NOT new infrastructure: it wires four existing pieces into the
autonomous-fix path.

1. WHO reviews (topic-relevant, ≥2 independent) — reuse
   ``specialist_review_runner.select_specialist_agents`` to route the fix's
   affected files through the Lane-A domain touch-map (auth-security-expert,
   farm-expert, data-expert …). The independence rule tops the selection up to
   ≥2 with cross-cutting reviewers (security-reviewer, architectural-arbiter)
   when a single-domain fix would otherwise have one owner. The reviewers are
   read-only judges, separate from the fixer — the auditor is never part of the
   audited.

2. The VERDICT contract — each reviewer's verdict is a
   ``aria/agent-response/v1`` ``satisfaction_matrix`` entry (satisfied /
   blocked / contradicted) carrying ``evidence_refs``.

3. CONSENSUS — ≥2 distinct reviewers, unanimous ``satisfied``, mean confidence
   ≥ ``CONSENSUS_MIN_CONFIDENCE`` (0.80), reusing the same threshold the judge
   consensus gate uses.

4. ANTI-HALLUCINATION (the load-bearing part) — every reviewer's
   ``evidence_refs`` is re-verified against the git blob at the fix's base SHA
   via ``evidence_trust.classify_evidence_ref``. A reviewer that cites a file:line
   which does not resolve (``missing``/``invalid``) has hallucinated; the gate
   BLOCKS and escalates to HUMAN_REQUIRED instead of accepting the approval. A
   reviewer that dreams cannot approve a fix.

The gate is the implementation behind the ``expert_consensus_evidence_verified``
HARD_FAIL check (implementation_safety): a fix PR cannot open unless ≥2
independent topic-experts reach an evidence-verified unanimous consensus.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .evidence_trust import classify_evidence_ref
from .feedback_store import CONSENSUS_MIN_CONFIDENCE
from .human_required import record_human_required
from .specialist_review_runner import select_specialist_agents
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)

DEFAULT_MIN_REVIEWERS: int = 2

# Cross-cutting, domain-agnostic reviewers used to satisfy the ≥2-independence
# rule when the touch-map yields a single owner. They review from a different
# lens (security / architecture / root-cause) so the second opinion is genuinely
# independent, not a duplicate of the first.
_INDEPENDENCE_TOPUP: tuple[str, ...] = (
    "security-reviewer",
    "architectural-arbiter",
    "root-cause-auditor",
)

# Plan 031-R R3 (B3/B4) — the expert gate requires repo_verified evidence.
# Unlike the judge consensus gate (which gives worktree_candidate the benefit of
# the doubt), an autonomous fix's approval must cite evidence that resolves to
# the git blob at the fix's BASE SHA. Anything else — worktree_candidate,
# self_output, missing, invalid — is unverifiable here. This is the per-ref form
# of EvidencePolicy.require_repo_verified (evidence_trust.py).
_REQUIRED_TRUST_GRADE: str = "repo_verified"


def select_expert_reviewers(
    *,
    affected_files: list[str],
    profile: str = "standard",
    pressures: list[dict[str, Any]] | None = None,
    min_reviewers: int = DEFAULT_MIN_REVIEWERS,
) -> list[str]:
    """Select ≥``min_reviewers`` independent topic-relevant expert reviewers.

    Routes ``affected_files`` through the Lane-A domain touch-map (reused) and
    tops the result up with cross-cutting reviewers until there are at least
    ``min_reviewers`` distinct experts. Deterministic: same inputs → same set.
    """
    if min_reviewers < 2:
        raise GovernanceError("min_reviewers must be >= 2 (independence rule)")
    experts = list(
        select_specialist_agents(
            touched_services=affected_files,
            pressures=pressures or [],
            profile=profile,
        )
    )
    for topup in _INDEPENDENCE_TOPUP:
        if len(experts) >= min_reviewers:
            break
        if topup not in experts:
            experts.append(topup)
    return experts


def evaluate_expert_consensus(
    *,
    verdicts: list[dict[str, Any]],
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    base_sha: str | None = None,
    min_reviewers: int = DEFAULT_MIN_REVIEWERS,
    min_confidence: float = CONSENSUS_MIN_CONFIDENCE,
) -> dict[str, Any]:
    """Pure evaluation (no side effects) of expert verdicts on a fix.

    ``verdicts`` is a list of ``{expert, verdict, confidence?, evidence_refs?}``.
    Returns ``{approved, reason, distinct_reviewers, mean_confidence,
    unverifiable_refs}``. ``reason`` is empty when approved; otherwise one of
    ``insufficient_reviewers`` / ``not_unanimous_satisfied`` / ``low_confidence``
    / ``evidence_not_repo_verified``.

    Order of checks matters: structure (count, unanimity, confidence) first,
    evidence verification last — so a clearly-rejecting panel does not pay the
    git-blob cost, and the hallucination signal is only computed on an otherwise
    passing panel.
    """
    # Plan 031-R R3 (B4) — without a base SHA the gate cannot verify any ref
    # against the fix's committed code, so it fails closed rather than falling
    # back to worktree_candidate acceptance.
    if not base_sha:
        return {
            "approved": False,
            "reason": "base_sha_required",
            "distinct_reviewers": [],
        }

    distinct = sorted({str(v.get("expert") or "") for v in verdicts if v.get("expert")})
    if len(distinct) < min_reviewers:
        return {
            "approved": False,
            "reason": "insufficient_reviewers",
            "distinct_reviewers": distinct,
        }

    grades = {str(v.get("verdict")) for v in verdicts}
    if grades != {"satisfied"}:
        return {
            "approved": False,
            "reason": "not_unanimous_satisfied",
            "distinct_reviewers": distinct,
            "verdicts_seen": sorted(grades),
        }

    confidences = [float(v.get("confidence", 1.0)) for v in verdicts]
    mean_confidence = sum(confidences) / len(confidences)
    if mean_confidence < min_confidence:
        return {
            "approved": False,
            "reason": "low_confidence",
            "distinct_reviewers": distinct,
            "mean_confidence": mean_confidence,
        }

    # Plan 031-R R3 (B3) — each reviewer MUST cite at least one evidence ref.
    # An empty/absent evidence list is an ungrounded approval; the whole point of
    # the gate is evidence-grounded review.
    for v in verdicts:
        if not (v.get("evidence_refs") or []):
            return {
                "approved": False,
                "reason": "missing_evidence_refs",
                "distinct_reviewers": distinct,
                "expert": str(v.get("expert") or ""),
            }

    # Anti-hallucination: every reviewer's evidence_refs must resolve to the git
    # blob at the fix's base SHA (repo_verified). A ref that is worktree_candidate
    # / self_output / missing / invalid is not trustworthy for an autonomous fix.
    unverifiable: list[dict[str, str]] = []
    for v in verdicts:
        for ref in v.get("evidence_refs", []) or []:
            envelope = classify_evidence_ref(
                str(ref),
                workspace_root=workspace_root,
                context="expert_consensus_evidence_gate",
                target_sha=base_sha,
            )
            if envelope.trust_grade != _REQUIRED_TRUST_GRADE:
                unverifiable.append({
                    "expert": str(v.get("expert") or ""),
                    "ref": str(ref),
                    "trust_grade": envelope.trust_grade,
                })
    if unverifiable:
        return {
            "approved": False,
            "reason": "evidence_not_repo_verified",
            "distinct_reviewers": distinct,
            "mean_confidence": mean_confidence,
            "unverifiable_refs": unverifiable,
        }

    return {
        "approved": True,
        "reason": "",
        "distinct_reviewers": distinct,
        "mean_confidence": mean_confidence,
        "unverifiable_refs": [],
    }


def enforce_expert_consensus_gate(
    *,
    change_id: str,
    verdicts: list[dict[str, Any]],
    workspace_root: str | Path,
    head_sha: str,
    base_dir: str | Path | None = None,
    base_sha: str | None = None,
    min_reviewers: int = DEFAULT_MIN_REVIEWERS,
) -> dict[str, Any]:
    """The enforced gate behind ``expert_consensus_evidence_verified``.

    Evaluates the panel; emits an ``expert_consensus_check`` governance event;
    records the verdict to the canonical expert-verdict ledger (Plan 031-R R2)
    bound to ``head_sha`` so the pre-PR-open chokepoint can read it; on failure
    raises ``GovernanceError`` to block the fix PR. A failure caused by
    unverifiable (hallucinated) evidence ALSO escalates to a HUMAN_REQUIRED
    record — a reviewer citing a file:line that does not exist is a fabrication
    signal the operator must see.
    """
    result = evaluate_expert_consensus(
        verdicts=verdicts,
        workspace_root=workspace_root,
        base_dir=base_dir,
        base_sha=base_sha,
        min_reviewers=min_reviewers,
    )
    tools_root = ensure_tools_dir(base_dir)
    append_tools_governance(
        tools_root,
        "expert_consensus_check",
        {
            "change_id": change_id,
            "approved": result["approved"],
            "reason": result.get("reason", ""),
            "distinct_reviewers": result.get("distinct_reviewers", []),
        },
    )
    # Plan 031-R R2 — persist the verdict (approved or not) to the canonical
    # ledger so pr_manager can fail closed without re-dispatching reviewers.
    from .expert_verdicts import record_expert_verdicts
    record_expert_verdicts(
        change_id=change_id,
        base_sha=base_sha,
        head_sha=head_sha,
        verdicts=verdicts,
        approved=bool(result["approved"]),
        reason=result.get("reason", ""),
        unverifiable_refs=result.get("unverifiable_refs", []),
        base_dir=base_dir,
    )
    if result["approved"]:
        return result

    if result["reason"] == "evidence_not_repo_verified":
        record_human_required(
            request_id=f"expert-consensus-hallucination-{change_id}",
            severity="HIGH",
            reason=(
                f"Expert reviewer cited evidence that does not resolve in the "
                f"repo for change {change_id!r} — a hallucinated approval. The "
                f"fix is blocked; operator must verify the change manually. "
                f"Unverifiable refs: {result.get('unverifiable_refs')}"
            ),
            context={
                "kind": "expert_consensus_hallucination",
                "change_id": change_id,
                "unverifiable_refs": result.get("unverifiable_refs", []),
            },
            base_dir=base_dir,
        )

    raise GovernanceError(
        f"expert_consensus_evidence_verified_failed: change_id={change_id!r} "
        f"reason={result['reason']!r} reviewers={result.get('distinct_reviewers')}"
    )


__all__ = [
    "DEFAULT_MIN_REVIEWERS",
    "select_expert_reviewers",
    "evaluate_expert_consensus",
    "enforce_expert_consensus_gate",
]
