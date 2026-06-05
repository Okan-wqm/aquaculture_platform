from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from .auto_merge import (
    GitHubAdapter,
    _append_decision,
    _evaluate_triple_gate,
    _first_string,
    collect_github_snapshot,
    evaluate_auto_merge,
    record_pr_lifecycle,
)
from .enterprise_readiness import (
    EnterpriseReadinessVerdict,
    verify_enterprise_readiness,
)
from .tool_registry import GovernanceError, utc_now


MergeExecutor = Callable[
    [int, str, str | Path],
    dict[str, Any],
]


def merge_if_authorized(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    readiness_claim_id: str | None,
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
    merge_executor: MergeExecutor | None = None,
) -> dict[str, Any]:
    pr = adapter.get_pr(pr_number)
    record_pr_lifecycle(pr, event="observed", base_dir=base_dir, cycle_id=cycle_id)
    github = collect_github_snapshot(adapter, pr)
    if diff_text is None:
        diff_text = _diff_for_pr(adapter, pr, pr_number)
    decision = evaluate_auto_merge(
        pr=pr,
        github=github,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=True,
        diff_text=diff_text,
    )
    if not decision.get("eligible"):
        return decision

    head_sha = _required_decision_head_sha(decision)
    readiness = _verify_enterprise_readiness_for_merge(
        readiness_claim_id=readiness_claim_id,
        pr=pr,
        pr_number=pr_number,
        head_sha=head_sha,
        base_dir=base_dir,
    )
    if not readiness["valid"]:
        blocked = _blocked_decision(
            decision,
            stage="enterprise_readiness_verification",
            reasons=["merge_authority_readiness_blocked", *readiness["reasons"]],
            readiness_claim_id=readiness_claim_id,
            readiness=readiness,
        )
        _append_decision(base_dir, blocked)
        return blocked

    fresh_pr = adapter.get_pr(pr_number)
    fresh_github = collect_github_snapshot(adapter, fresh_pr)
    fresh_decision = evaluate_auto_merge(
        pr=fresh_pr,
        github=fresh_github,
        policy=policy,
        base_dir=None,
        cycle_id=cycle_id,
        dry_run=True,
        diff_text=_diff_for_pr(adapter, fresh_pr, pr_number),
    )
    if not fresh_decision.get("eligible"):
        blocked = _blocked_decision(
            decision,
            stage="pre_merge_re_evaluation",
            reasons=[
                "pre_merge_re_evaluation_blocked",
                *list(fresh_decision.get("reasons") or []),
            ],
            readiness_claim_id=readiness_claim_id,
            readiness=readiness,
            fresh_decision=fresh_decision,
        )
        _append_decision(base_dir, blocked)
        return blocked

    expected_head_sha = _required_decision_head_sha(fresh_decision)
    if expected_head_sha != head_sha:
        blocked = _blocked_decision(
            decision,
            stage="pre_merge_re_evaluation",
            reasons=["pre_merge_head_sha_drift"],
            readiness_claim_id=readiness_claim_id,
            readiness=readiness,
            fresh_decision=fresh_decision,
        )
        _append_decision(base_dir, blocked)
        return blocked

    triple = _evaluate_triple_gate(
        pr_number=pr_number,
        head_sha=expected_head_sha,
        base_dir=base_dir,
    )
    if not triple["passed"]:
        blocked = _blocked_decision(
            decision,
            stage="triple_gate_pre_merge",
            reasons=["auto_merge_triple_gate_blocked", *triple["reasons"]],
            readiness_claim_id=readiness_claim_id,
            readiness=readiness,
            fresh_decision=fresh_decision,
            change_id=triple.get("change_id"),
        )
        _append_decision(base_dir, blocked)
        return blocked

    authorized = dict(decision)
    authorized.update(
        {
            "recorded_at": utc_now(),
            "decision": "authorized" if dry_run else "merge_authorized",
            "eligible": True,
            "stage": "merge_authority",
            "readiness_claim_id": readiness_claim_id,
            "readiness": readiness,
            "fresh_decision": fresh_decision,
            "change_id": triple.get("change_id"),
            "expected_head_sha": expected_head_sha,
        },
    )
    if dry_run:
        _append_decision(base_dir, authorized)
        return authorized

    executor = merge_executor or execute_gh_squash_merge
    try:
        merge_result = executor(pr_number, expected_head_sha, _adapter_cwd(adapter))
    except Exception as exc:
        failed = dict(authorized)
        failed.update(
            {
                "recorded_at": utc_now(),
                "decision": "failed",
                "eligible": False,
                "reasons": [str(exc)],
            },
        )
        _append_decision(base_dir, failed)
        return failed

    merged = dict(authorized)
    merged.update(
        {
            "recorded_at": utc_now(),
            "decision": "merged",
            "eligible": True,
            "merge_result": merge_result,
        },
    )
    _append_decision(base_dir, merged)
    record_pr_lifecycle(fresh_pr, event="merged", base_dir=base_dir, cycle_id=cycle_id)
    return merged


def execute_gh_squash_merge(
    pr_number: int,
    expected_head_sha: str,
    cwd: str | Path = ".",
) -> dict[str, Any]:
    if not isinstance(expected_head_sha, str) or not expected_head_sha.strip():
        raise GovernanceError("expected_head_sha_required")
    completed = subprocess.run(
        [
            "gh",
            "pr",
            "merge",
            str(pr_number),
            "--squash",
            "--match-head-commit",
            expected_head_sha,
        ],
        cwd=Path(cwd),
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise GovernanceError(
            completed.stderr.strip()
            or completed.stdout.strip()
            or "gh pr merge failed"
        )
    return {
        "merged": True,
        "method": "squash",
        "expected_head_sha": expected_head_sha,
    }


def _diff_for_pr(
    adapter: GitHubAdapter,
    pr: dict[str, Any],
    pr_number: int,
) -> str | None:
    diff_text = pr.get("diff_text")
    if diff_text is not None:
        return diff_text
    if hasattr(adapter, "get_pr_diff"):
        try:
            return adapter.get_pr_diff(pr_number)  # type: ignore[attr-defined]
        except Exception:
            return None
    return None


def _required_decision_head_sha(decision: dict[str, Any]) -> str:
    head_sha = _first_string(decision, "head_sha")
    if head_sha is None:
        raise GovernanceError("expected_head_sha_required")
    return head_sha


def _blocked_decision(
    decision: dict[str, Any],
    *,
    stage: str,
    reasons: list[str],
    readiness_claim_id: str | None,
    readiness: dict[str, Any] | None = None,
    fresh_decision: dict[str, Any] | None = None,
    change_id: str | None = None,
) -> dict[str, Any]:
    blocked = dict(decision)
    blocked.update(
        {
            "recorded_at": utc_now(),
            "decision": "blocked",
            "eligible": False,
            "stage": stage,
            "reasons": reasons,
            "readiness_claim_id": readiness_claim_id,
        },
    )
    if readiness is not None:
        blocked["readiness"] = readiness
    if fresh_decision is not None:
        blocked["fresh_decision"] = fresh_decision
    if change_id is not None:
        blocked["change_id"] = change_id
    return blocked


def _adapter_cwd(adapter: GitHubAdapter) -> str | Path:
    cwd = getattr(adapter, "cwd", ".")
    if isinstance(cwd, (str, Path)):
        return cwd
    return "."


def _verify_enterprise_readiness_for_merge(
    *,
    readiness_claim_id: str | None,
    pr: dict[str, Any],
    pr_number: int,
    head_sha: str,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    if not isinstance(readiness_claim_id, str) or not readiness_claim_id.strip():
        return {
            "valid": False,
            "failure_classes": ["readiness_claim_id_required"],
            "reasons": ["readiness_claim_id_required"],
            "proof_refs": {},
        }
    if base_dir is None:
        return {
            "valid": False,
            "failure_classes": ["readiness_base_dir_required"],
            "reasons": ["readiness_base_dir_required"],
            "proof_refs": {},
        }
    try:
        verdict = verify_enterprise_readiness(
            pr_number=pr_number,
            readiness_claim_id=readiness_claim_id,
            base_dir=base_dir,
            repository=_first_string(pr, "repository", "repo_full_name"),
            target_ref=_first_string(pr, "target_ref", "base_branch", "baseRefName", "base"),
            head_ref=_first_string(pr, "head_ref", "headRefName", "source_ref"),
            head_sha=head_sha,
        )
    except GovernanceError as exc:
        return {
            "valid": False,
            "failure_classes": ["enterprise_readiness_verification_failed"],
            "reasons": [str(exc)],
            "proof_refs": {},
        }
    return _readiness_verdict_payload(verdict)


def _readiness_verdict_payload(verdict: EnterpriseReadinessVerdict) -> dict[str, Any]:
    return {
        "valid": verdict.valid,
        "failure_classes": list(verdict.failure_classes),
        "reasons": list(verdict.reasons),
        "proof_refs": dict(verdict.proof_refs),
    }
