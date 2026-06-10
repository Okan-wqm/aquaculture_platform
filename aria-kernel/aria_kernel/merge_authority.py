from __future__ import annotations

from pathlib import Path
from typing import Any

from .auto_merge import (
    GitHubAdapter,
    _append_decision,
    _evaluate_triple_gate,
    _merge_if_green_with_executor,
    collect_github_snapshot,
    evaluate_auto_merge,
    record_pr_lifecycle,
)
from .enterprise_readiness import verify_enterprise_readiness
from .runtime_profile import enforce_profile_for_action
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


def merge_pr_if_ready(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
    cycle_id: str | None = None,
    diff_text: str | None = None,
    readiness_claim_id: str | None = None,
) -> dict[str, Any]:
    """Single real-merge authority for ARIA-governed PRs.

    ``auto_merge.merge_if_green`` remains evaluation-only. This wrapper owns
    the real merge boundary: attempts must pass the runtime-profile gate,
    ledger-bound enterprise readiness, auto-merge eligibility, the change-ledger
    triple gate, and a final live re-evaluation immediately before invoking
    ``adapter.merge_pr``.
    """
    profile = enforce_profile_for_action("pr_merge", base_dir=base_dir)
    if not readiness_claim_id or not readiness_claim_id.strip():
        raise GovernanceError("merge_authority_requires_readiness_claim_id")
    readiness = verify_enterprise_readiness(
        pr_number=pr_number,
        adapter=adapter,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    if not readiness.valid:
        raise GovernanceError(
            "enterprise_readiness_required_for_merge: " + "; ".join(readiness.reasons)
        )

    decision = _merge_if_green_with_executor(
        adapter=adapter,
        pr_number=pr_number,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=True,
        diff_text=diff_text,
    )
    result = decision
    if decision.get("eligible"):
        head_sha = str(decision["head_sha"])
        triple = _evaluate_triple_gate(
            pr_number=pr_number,
            head_sha=head_sha,
            base_dir=base_dir,
        )
        if not triple["passed"]:
            result = dict(decision)
            result.update(
                {
                    "recorded_at": utc_now(),
                    "decision": "blocked",
                    "eligible": False,
                    "reasons": [
                        "auto_merge_triple_gate_blocked",
                        *triple["reasons"],
                    ],
                    "stage": "triple_gate_pre_merge",
                    "change_id": triple.get("change_id"),
                },
            )
            _append_decision(base_dir, result)
        else:
            fresh_pr = adapter.get_pr(pr_number)
            fresh_github = collect_github_snapshot(adapter, fresh_pr)
            fresh_diff: str | None = None
            if hasattr(adapter, "get_pr_diff"):
                try:
                    fresh_diff = adapter.get_pr_diff(pr_number)  # type: ignore[attr-defined]
                except Exception:
                    fresh_diff = None
            if fresh_diff is None:
                fresh_diff = fresh_pr.get("diff_text")
            fresh_decision = evaluate_auto_merge(
                pr=fresh_pr,
                github=fresh_github,
                policy=policy,
                base_dir=None,
                cycle_id=cycle_id,
                dry_run=True,
                diff_text=fresh_diff,
            )
            latest_head_sha = fresh_decision.get("head_sha")
            if not fresh_decision.get("eligible"):
                result = dict(decision)
                result.update(
                    {
                        "recorded_at": utc_now(),
                        "decision": "blocked",
                        "eligible": False,
                        "latest_head_sha": latest_head_sha,
                        "reasons": [
                            "pre_merge_re_evaluation_blocked",
                            *list(fresh_decision.get("reasons") or []),
                        ],
                        "stage": "pre_merge_re_evaluation",
                    },
                )
                _append_decision(base_dir, result)
            elif latest_head_sha != head_sha:
                result = dict(decision)
                result.update(
                    {
                        "recorded_at": utc_now(),
                        "decision": "blocked",
                        "eligible": False,
                        "latest_head_sha": latest_head_sha,
                        "reasons": ["PR head SHA changed after green evaluation"],
                        "stage": "pre_merge_re_evaluation",
                    },
                )
                _append_decision(base_dir, result)
            else:
                try:
                    merge_result = adapter.merge_pr(
                        pr_number,
                        method="squash",
                        expected_head_sha=head_sha,
                    )
                except Exception as exc:  # pragma: no cover - exercised by adapter fakes
                    result = dict(decision)
                    result.update(
                        {
                            "recorded_at": utc_now(),
                            "decision": "failed",
                            "eligible": False,
                            "reasons": [str(exc)],
                        },
                    )
                    _append_decision(base_dir, result)
                else:
                    result = dict(decision)
                    result.update(
                        {
                            "recorded_at": utc_now(),
                            "decision": "merged",
                            "eligible": True,
                            "merge_result": merge_result,
                        },
                    )
                    _append_decision(base_dir, result)
                    record_pr_lifecycle(
                        fresh_pr,
                        event="merged",
                        base_dir=base_dir,
                        cycle_id=cycle_id,
                    )
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "merge_authority_decision",
        {
            "profile": profile,
            "pr_number": pr_number,
            "decision": result.get("decision"),
            "eligible": result.get("eligible"),
            "cycle_id": cycle_id,
            "readiness_claim_id": readiness_claim_id,
            "readiness_failure_classes": list(readiness.failure_classes),
        },
    )
    return result


__all__ = ["merge_pr_if_ready"]
