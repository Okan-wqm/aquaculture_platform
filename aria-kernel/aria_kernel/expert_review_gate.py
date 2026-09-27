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

The final merge perimeter uses this module to request review of a natively
accepted implementation. The evaluator below is also available to existing
callers. The ``expert_consensus_evidence_verified`` registry predicate remains
closed until accepted expert results are joined; pending requests are not
consensus evidence.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .evidence_probe import GitProbeSession
from .evidence_trust import classify_evidence_ref
from .feedback_store import CONSENSUS_MIN_CONFIDENCE
from .human_required import record_human_required
from .implementation_safety import HardFailContext as _HardFailContext
from .implementation_safety import HardFailReport as _HardFailReport
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

# Evidence grades that count as a hallucination (a ref that does not resolve in
# the repo). Mirrors feedback_store._has_unverifiable_evidence — worktree_candidate
# gets the benefit of the doubt; repo_verified / self_output pass.
_UNVERIFIABLE_GRADES: frozenset[str] = frozenset({"missing", "invalid"})


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


def _ensure_implementation_expert_requests(
    context: _HardFailContext,
    report: _HardFailReport,
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
) -> tuple[str, ...]:
    """Request final review of the implementation admitted by native checks.

    This producer runs after the registry at the real merge perimeter. Pending
    requests are not verdicts and cannot make the existing report pass.
    """
    from .agent_invocations import create_agent_invocation_request
    from .implementation_safety import _native_implementation_is_bound
    import json

    required = {
        "branch_tip_lock_and_recheck", "content_hash_recheck",
        "per_file_mutual_exclusion", "plan_coverage_witness_verified",
    }
    evidence = context.pre_merge_evidence
    if (
        not _native_implementation_is_bound(context)
        or context.workspace_root is None or not context.affected_paths
        or context.diff_text is None
        or not evidence.change_id or not evidence.plan_id
    ):
        return ()
    passed = {result.name for result in report.results if result.passed}
    if not required.issubset(passed):
        return ()

    binding = {
        "change_id": evidence.change_id,
        "request_id": evidence.request_id,
        "claim_id": evidence.claim_id,
        "request_row_hash": evidence.request_row_hash,
        "claim_row_hash": evidence.claim_row_hash,
        "result_row_hash": evidence.result_row_hash,
        "committed_row_hash": evidence.committed_row_hash,
        "implementation_event_hash": evidence.implementation_event_hash,
        "plan_id": evidence.plan_id,
        "plan_revision_id": evidence.plan_revision_id,
        "plan_content_hash": evidence.plan_content_hash,
        "head_sha": evidence.head_sha,
        "base_sha": evidence.base_sha,
        "diff_hash": evidence.implementation_diff_hash,
    }
    paths = list(context.affected_paths)
    request_ids = []
    for expert in select_expert_reviewers(affected_files=paths):
        request = create_agent_invocation_request(
            target_agent=expert,
            role="specialist_domain_review",
            suggested_prompt=(
                "Review the accepted implementation for your declared domain. "
                "Judge the final source at target_sha and the base-to-head diff; "
                "a pre-implementation plan review does not satisfy this request. "
                "Return an explicit satisfaction verdict with file:line evidence.\n"
                "Native implementation binding:\n"
                + json.dumps(binding, sort_keys=True)
                + "\nVerified diff (surrounding whitespace trimmed):\n"
                + context.diff_text.strip()
            ),
            must_satisfy=[{
                "id": f"implementation-expert-review-{expert}",
                "description": "Review the bound final implementation with source evidence.",
                "implementation_binding": binding,
            }],
            allowed_scope=paths,
            evidence_refs=[path + ":1" for path in paths],
            convergence_id=evidence.plan_id,
            plan_revision_hash=evidence.plan_content_hash,
            target_sha=evidence.head_sha,
            context_repo_root=context.workspace_root,
            context_source_paths=paths,
            cycle_id=cycle_id,
            base_dir=base_dir,
        )
        request_ids.append(request["request_id"])
    return tuple(request_ids)


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

    # Anti-hallucination: re-verify every reviewer's evidence_refs against the
    # git blob at the fix's base SHA. A ref that does not resolve is a fabricated
    # citation — the approval is not trustworthy.
    #
    # ONE panel, ONE probe session (evidence_probe): the base SHA is resolved
    # once for every reviewer's refs and every probe of the panel shares one
    # liveness clock, as the acceptance validator does per submission.
    probe_session = GitProbeSession()
    unverifiable: list[dict[str, str]] = []
    for v in verdicts:
        for ref in v.get("evidence_refs", []) or []:
            envelope = classify_evidence_ref(
                str(ref),
                workspace_root=workspace_root,
                context="expert_consensus_evidence_gate",
                target_sha=base_sha,
                probe_session=probe_session,
            )
            if envelope.trust_grade in _UNVERIFIABLE_GRADES:
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
    base_dir: str | Path | None = None,
    base_sha: str | None = None,
    min_reviewers: int = DEFAULT_MIN_REVIEWERS,
) -> dict[str, Any]:
    """The enforced gate behind ``expert_consensus_evidence_verified``.

    Evaluates the panel; emits an ``expert_consensus_check`` governance event;
    on failure raises ``GovernanceError`` to block the fix PR. A failure caused
    by unverifiable (hallucinated) evidence ALSO escalates to a HUMAN_REQUIRED
    record — a reviewer citing a file:line that does not exist is a fabrication
    signal the operator must see, exactly as the judge-consensus evidence gate
    escalates fabricated judge evidence.
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
