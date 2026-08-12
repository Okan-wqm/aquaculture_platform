"""E2/F1 — the producer of `implementation_merged` (the arc's last event).

WHY: the transition existed with full ceremony and no writer. The merge
itself is performed by the OPERATOR on GitHub (ARIA never merges its own
work — standing rule), so the truthful producer is a RECONCILER: each
cycle, every plan resting in IMPLEMENTATION_RECORDED is checked against
GitHub's own answer for its recorded PR; a merged PR becomes the
`implementation_merged` terminal event with the V9.6 idempotency 5-tuple.

Deterministic and ledger-derived: the inputs are the plan fold (pr_url,
diff_hash, branch_tip_sha) and the reader's answer; re-running against a
merged plan is a no-op (terminal state + idempotent _mutate).

Small on purpose — operator preference: files stay short.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .plan_convergence import (
    fold_plan_state,
    list_active_plans,
    record_implementation_merged,
)
from .tool_registry import GovernanceError

_PR_NUMBER_RE = re.compile(r"/pull/(\d+)")


def _pr_number_from_url(pr_url: str) -> int | None:
    match = _PR_NUMBER_RE.search(pr_url or "")
    return int(match.group(1)) if match else None


def _idempotency_key_hash(
    plan_id: str, diff_hash: str, pr_number: int, base_branch: str, branch_tip_sha: str
) -> str:
    canonical = "|".join((plan_id, diff_hash, str(pr_number), base_branch, branch_tip_sha))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def reconcile_recorded_implementations(
    *,
    base_dir: str | Path | None,
    reader: Any,
    base_branch: str = "main",
) -> dict[str, Any]:
    """Fold every RECORDED plan forward if its PR is merged on GitHub."""
    readable, reason = reader.readable()
    if not readable:
        return {"status": "unreadable", "reason": reason, "merged": [], "checked": 0}

    merged: list[dict[str, Any]] = []
    checked = 0
    for plan_id in list_active_plans(base_dir=base_dir):
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        if not isinstance(state, dict) or state.get("state") != "IMPLEMENTATION_RECORDED":
            continue
        impl = state.get("implementation") or {}
        pr_number = _pr_number_from_url(str(impl.get("pr_url") or ""))
        if pr_number is None:
            continue
        checked += 1
        remote = reader.pr_merge_state(pr_number)
        if not isinstance(remote, dict):
            continue
        merged_at = remote.get("mergedAt")
        merge_commit = remote.get("mergeCommit") or {}
        merge_sha = str(merge_commit.get("oid") or "") if isinstance(merge_commit, dict) else ""
        if str(remote.get("state") or "").upper() != "MERGED" or not merged_at or not merge_sha:
            continue
        try:
            record_implementation_merged(
                plan_id=plan_id,
                merge_sha=merge_sha,
                merged_at=str(merged_at),
                idempotency_key_hash=_idempotency_key_hash(
                    plan_id,
                    str(impl.get("diff_hash") or ""),
                    pr_number,
                    base_branch,
                    str(impl.get("branch_tip_sha") or ""),
                ),
                base_dir=base_dir,
            )
        except GovernanceError:
            # A concurrent fold already moved the plan; terminal states are
            # idempotent, anything else is visible on the next cycle.
            continue
        merged.append({"plan_id": plan_id, "pr_number": pr_number, "merge_sha": merge_sha})

    return {"status": "reconciled", "merged": merged, "checked": checked}
