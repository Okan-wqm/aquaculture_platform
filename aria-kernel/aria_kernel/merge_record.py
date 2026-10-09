"""ARIA-HIGH-390 — "this ARIA PR merged" has one writer.

THE MEASURED GAP (2026-10-09, before PR #1906 — F-015 — was merged by hand).
Three things wrote "merged", each from its own source:

* ``merge_authority`` wrote the ``pr-lifecycle`` ``merged`` row, and only for
  merges ARIA's own merge lane performed;
* ``implementation_reconciler`` wrote the plan ledger's
  ``implementation_merged``, from GitHub, and only for plans resting in
  IMPLEMENTATION_RECORDED;
* ``own_pr_ci`` lists merged own PRs from GitHub for the post-merge CI
  verdict (``ci/merge-outcomes.jsonl``) — a different fact, kept as it is.

A person's merge therefore reached the plan ledger but never ``pr-lifecycle``:
``change_outcome`` refuses every outcome without that row
(``change_outcome_requires_merged_change``) and change intelligence never
saw the merge. A plan the kernel had ended after its PR existed (a result
refused after delivery, ARIA-HIGH-389; a reaped orphan) reached neither: a
person's merge of its PR was a resolved HUMAN_REQUIRED record and nothing
else, its finding never closed.

THE RULE. :func:`record_merge` is the only writer of both facts, and writes
them together: the ``pr-lifecycle`` ``merged`` row (once per PR) and, for a
plan, its ``implementation_merged`` event. The two observers of a merge —
the merge lane that performed it and the reconciler that reads GitHub —
call it; ``tests/invariants`` fails the build when anything else writes
either fact. The plan then folds MERGED, and the reconciler's existing
passes close its finding (and the subject's duplicates, ARIA-HIGH-363) and
promote its convention: one closure path, one learning path.

A REJECTED plan folds MERGED only on an observed merge of its own PR
(:func:`verify_merge_after_rejection`): the ``opened`` row the kernel wrote
for the plan's change, GitHub reporting that PR MERGED with a merge commit,
and the merged head equal to the head the kernel recorded when it opened the
PR. A payload alone proves nothing.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

MERGED_BY_MERGE_LANE = "aria_merge_lane"
MERGED_BY_OBSERVED = "observed_on_github"
MERGED_BY_VALUES = frozenset({MERGED_BY_MERGE_LANE, MERGED_BY_OBSERVED})


class MergeNotProven(ValueError):
    """An asserted merge the observed facts do not support; nothing is written."""


def lifecycle_rows(base_dir: str | Path) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl
    from .tool_registry import ensure_tools_dir

    path = ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl"
    return load_declared_jsonl(path, expected_surface="pr_lifecycle") if path.is_file() else []


def opened_row(rows: list[dict[str, Any]], *, pr_number: int | None = None,
               change_id: str | None = None) -> dict[str, Any] | None:
    """The latest ``opened`` row the kernel wrote for a PR number or a change."""
    found = None
    for row in rows:
        if row.get("event") != "opened":
            continue
        if pr_number is not None and row.get("pr_number") != pr_number:
            continue
        if change_id is not None and row.get("change_id") != change_id:
            continue
        found = row
    return found


def verify_merge_after_rejection(
    *, opened: Mapping[str, Any] | None, remote: Mapping[str, Any] | None,
) -> tuple[str, str]:
    """(merge commit sha, merged at) when GitHub's answer proves the kernel's PR merged at its delivered head.

    Raises :class:`MergeNotProven` naming the first fact that does not hold.
    """
    if not isinstance(opened, Mapping) or type(opened.get("pr_number")) is not int or not opened.get("head_sha"):
        raise MergeNotProven("no_opened_row_for_the_plans_change")
    if not isinstance(remote, Mapping):
        raise MergeNotProven("github_unanswered")
    if remote.get("number") not in (None, opened["pr_number"]):
        raise MergeNotProven("github_answered_another_pr")
    commit = remote.get("mergeCommit") if isinstance(remote.get("mergeCommit"), Mapping) else {}
    merge_sha, merged_at = str(commit.get("oid") or ""), str(remote.get("mergedAt") or "")
    if str(remote.get("state") or "").upper() != "MERGED" or not merge_sha or not merged_at:
        raise MergeNotProven("pr_not_merged")
    if str(remote.get("headRefOid") or "") != str(opened["head_sha"]):
        raise MergeNotProven("merged_head_is_not_the_delivered_head")
    return merge_sha, merged_at


def record_merge(
    *,
    pr: Mapping[str, Any],
    merged_by: str,
    base_dir: str | Path,
    cycle_id: str | None = None,
    plan_id: str | None = None,
    merge_sha: str | None = None,
    merged_at: str | None = None,
    idempotency_key_hash: str | None = None,
    merged_after_rejection: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Record that ARIA's PR ``pr`` merged: its lifecycle row (once) and, for ``plan_id``, the plan's merge.

    ``pr`` is the PR as its observer holds it (the merge lane's GitHub payload,
    or the kernel's own ``opened`` row with the observed merge). Idempotent:
    a PR with a ``merged`` row gets no second one, and a plan already MERGED
    is not written again. Returns what was written.
    """
    from .auto_merge import record_pr_lifecycle
    from .plan_convergence import fold_plan_state, record_implementation_merged

    if merged_by not in MERGED_BY_VALUES:
        raise ValueError(f"merged_by must be one of {sorted(MERGED_BY_VALUES)}")
    number = pr.get("number", pr.get("pr_number"))
    if type(number) is not int:
        raise MergeNotProven("pr_number_missing")
    written: dict[str, Any] = {"pr_number": number, "lifecycle_row": False, "plan_event": None}
    if not any(row.get("event") == "merged" and row.get("pr_number") == number for row in lifecycle_rows(base_dir)):
        record_pr_lifecycle({**dict(pr), "number": number}, event="merged", base_dir=base_dir, cycle_id=cycle_id)
        written["lifecycle_row"] = True
    if plan_id is None:
        return written
    if fold_plan_state(plan_id=plan_id, base_dir=base_dir).get("state") == "IMPLEMENTATION_MERGED":
        return written
    if not merge_sha or not merged_at or not idempotency_key_hash:
        raise MergeNotProven("plan_merge_needs_sha_time_and_key")
    written["plan_event"] = record_implementation_merged(
        plan_id=plan_id, merge_sha=merge_sha, merged_at=merged_at, idempotency_key_hash=idempotency_key_hash,
        merged_after_rejection=dict(merged_after_rejection) if merged_after_rejection is not None else None,
        base_dir=base_dir,
    )
    return written


__all__ = [
    "MERGED_BY_MERGE_LANE",
    "MERGED_BY_OBSERVED",
    "MergeNotProven",
    "lifecycle_rows",
    "opened_row",
    "record_merge",
    "verify_merge_after_rejection",
]
