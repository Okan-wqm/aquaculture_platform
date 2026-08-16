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
from .autonomy_unlock import assert_autonomy_unlocked
from .enterprise_readiness import verify_enterprise_readiness
from .incident_ledger import (
    ensure_pre_merge_incident_row,
    finalize_merge_incident,
    record_merge_failed_incident,
)
from .policy_approval import verify_policy_approval
from .risk_policy import record_risk_decision_for_pr
from .rollback_bundle import verify_rollback_bundle
from .runtime_profile import enforce_profile_for_action
from .runner_attestation import verify_runner_attestation
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now
from .watchdog_freeze import assert_merge_not_watchdog_frozen


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
    enterprise risk policy, autonomy unlock thresholds, ledger-bound enterprise
    readiness, runner and rollback evidence, incident pre-row, auto-merge
    eligibility, the change-ledger triple gate, and a final live re-evaluation
    immediately before invoking ``adapter.merge_pr``.
    """
    profile = enforce_profile_for_action("pr_merge", base_dir=base_dir)
    # ORPHAN-MEDIUM-562 — the external watchdog reports a stalled ARIA memory
    # and cannot freeze anything itself, because freezing needs the kernel it
    # is watching. The alarm is read HERE, at the single real-merge authority:
    # it stops ARIA merging on state nobody can attest to, while leaving the
    # cycle free to publish the state that closes the incident and leaving
    # human pull requests alone.
    assert_merge_not_watchdog_frozen(adapter=adapter)
    if not readiness_claim_id or not readiness_claim_id.strip():
        raise GovernanceError("merge_authority_requires_readiness_claim_id")
    live_pr = adapter.get_pr(pr_number)
    if not isinstance(live_pr, dict) or not live_pr:
        raise GovernanceError("merge_authority_live_pr_required")
    head_sha = _head_sha(live_pr)
    if not head_sha:
        raise GovernanceError("merge_authority_head_sha_required")

    risk = record_risk_decision_for_pr(
        live_pr,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    if risk.get("valid") is not True:
        raise GovernanceError(
            "risk_policy_required_for_merge: "
            + "; ".join(str(item) for item in risk.get("reason_codes") or [])
        )
    lane = str(risk.get("lane") or "")
    unlock = assert_autonomy_unlocked(lane=lane, base_dir=base_dir)
    policy_approval: dict[str, Any] | None = None
    if lane == "L3":
        policy_approval = verify_policy_approval(
            pr_number=pr_number,
            head_sha=head_sha,
            policy_hash=str(risk.get("policy_hash") or ""),
            base_dir=base_dir,
        )

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
    runner = verify_runner_attestation(
        pr_number=pr_number,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    rollback = verify_rollback_bundle(
        pr_number=pr_number,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    incident_pre = ensure_pre_merge_incident_row(
        pr=live_pr,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
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
                merge_kwargs: dict[str, Any] = {
                    "method": "squash",
                    "expected_head_sha": head_sha,
                }
                authority_token = f"merge-authority:{pr_number}:{head_sha}"
                armed = False
                if hasattr(adapter, "arm_merge_authority"):
                    adapter.arm_merge_authority(authority_token)  # type: ignore[attr-defined]
                    merge_kwargs["authority_token"] = authority_token
                    armed = True
                try:
                    merge_result = adapter.merge_pr(pr_number, **merge_kwargs)
                except Exception as exc:  # pragma: no cover - exercised by adapter fakes
                    record_merge_failed_incident(
                        pr=fresh_pr,
                        readiness_claim_id=readiness_claim_id,
                        reason=str(exc),
                        base_dir=base_dir,
                    )
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
                    finalize_merge_incident(
                        pr=fresh_pr,
                        readiness_claim_id=readiness_claim_id,
                        merge_result=merge_result,
                        base_dir=base_dir,
                    )
                    record_pr_lifecycle(
                        fresh_pr,
                        event="merged",
                        base_dir=base_dir,
                        cycle_id=cycle_id,
                    )
                finally:
                    if armed and hasattr(adapter, "clear_merge_authority"):
                        adapter.clear_merge_authority(authority_token)  # type: ignore[attr-defined]
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "merge_authority_decision",
        {
            "profile": profile,
            "pr_number": pr_number,
            "risk_lane": lane,
            "risk_policy_hash": risk.get("policy_hash"),
            "unlock_counts": unlock.counts,
            "policy_approval": policy_approval,
            "runner_attestation": runner,
            "rollback_bundle": rollback,
            "incident_pre_row_hash": incident_pre.get("ledger_hash"),
            "decision": result.get("decision"),
            "eligible": result.get("eligible"),
            "cycle_id": cycle_id,
            "readiness_claim_id": readiness_claim_id,
            "readiness_failure_classes": list(readiness.failure_classes),
        },
    )
    return result


def _head_sha(pr: dict[str, Any]) -> str:
    for key in ("head_sha", "headRefOid", "head"):
        value = pr.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


__all__ = ["merge_pr_if_ready"]
