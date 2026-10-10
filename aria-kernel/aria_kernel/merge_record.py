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
``change_outcome`` refuses every outcome without that row and change
intelligence never saw the merge. A plan the kernel had ended after its PR
existed (a result refused after delivery, ARIA-HIGH-389; a reaped orphan)
reached neither: a person's merge of its PR was a resolved HUMAN_REQUIRED
record and nothing else, its finding never closed.

THE RULE. :func:`record_merge` is the only writer of both facts, and writes
them together: the ``pr-lifecycle`` ``merged`` row (once per PR, under the
ledger's lock) and, for a plan, its ``implementation_merged`` event. Both
writers are closed to anything else at the source:
``plan_convergence._record_implementation_merged`` is private, and
``auto_merge.record_pr_lifecycle`` refuses ``event="merged"`` without the
owner token this module alone imports; ``tests/invariants`` fails the build
on any other path to either.

WHAT THE ROW SAYS. The merged row carries what GitHub observed — the head
that merged, the merge commit, ``merged_at`` — beside the head the kernel
delivered, and the head's LINEAGE (:func:`classify_merged_head`):
``delivered`` (the same commit), ``base_merged`` (every later commit is a
pure merge of the base, GitHub's update-branch), ``patch_unchanged`` (the
delivered patch, rebased), or ``head_diverged`` / ``head_unverifiable``.
Readers that credit ARIA's change (``change_outcome``, ``pr_tracking``)
refuse a diverged merge: a person's commits on ARIA's branch are not ARIA's.

A REJECTED plan folds MERGED only on an observed merge of its own PR whose
head is ARIA's by that lineage (:func:`verify_merge_after_rejection`). A merge
refused for a named fact (a diverged head) ends the PR's lifecycle; a head that
could not be read is retried for :data:`MAX_LINEAGE_CHECKS` cycles before it is
disclosed as unproven; a PR closed unmerged is asked again once a day, bounded,
since a reopen writes no ``opened`` row. Learning (convention promotion, the
implementer's merged episode) credits ARIA only for ARIA's lineages; impact
analysis sees every merge, attributed or not.
"""
from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

MERGED_BY_MERGE_LANE = "aria_merge_lane"
MERGED_BY_OBSERVED = "observed_on_github"
MERGED_BY_VALUES = frozenset({MERGED_BY_MERGE_LANE, MERGED_BY_OBSERVED})

LINEAGE_DELIVERED = "delivered"
LINEAGE_BASE_MERGED = "base_merged"
LINEAGE_PATCH_UNCHANGED = "patch_unchanged"
LINEAGE_DIVERGED = "head_diverged"
LINEAGE_UNVERIFIABLE = "head_unverifiable"
# Review of #1910, N4 — a row written from the plan's own merge facts, with no
# head to classify: never ARIA's (fail closed).
LINEAGE_BACKFILLED_UNVERIFIED = "backfilled_unverified"
LINEAGES = frozenset({LINEAGE_DELIVERED, LINEAGE_BASE_MERGED, LINEAGE_PATCH_UNCHANGED, LINEAGE_DIVERGED,
                      LINEAGE_UNVERIFIABLE, LINEAGE_BACKFILLED_UNVERIFIED})
# The lineages whose merged change is ARIA's delivered change.
ARIAS_LINEAGES = frozenset({LINEAGE_DELIVERED, LINEAGE_BASE_MERGED, LINEAGE_PATCH_UNCHANGED})

# Terminal lifecycle events of an ARIA PR this module writes besides `merged`.
EVENT_CLOSED_UNMERGED = "closed_unmerged"
EVENT_MERGE_UNPROVEN = "merge_unproven"
# Non-terminal: one GitHub-reported merge whose head could not be read this
# cycle (review of #1910, N2). Counted per PR; at the bound the merge is
# recorded as unproven (a REJECTED plan's) or as merged-but-unverified (a
# RECORDED plan's), each a named disclosure.
EVENT_LINEAGE_UNVERIFIED = "merge_lineage_unverified"
MAX_LINEAGE_CHECKS = 6
# Review of #1910, L1 — a PR closed unmerged is asked again at most once a
# day, at most this many times: a reopen writes no `opened` row.
CLOSED_RECHECK_INTERVAL_SECONDS = 24 * 3600
MAX_CLOSED_RECHECKS = 14
_MAX_WALK = 50


class MergeNotProven(ValueError):
    """An asserted merge the observed facts do not support; nothing is written."""


class MergeLineageUnverified(MergeNotProven):
    """A merge GitHub reports whose head could not be read this time: retried, not refused (review of #1910, N2)."""


def lifecycle_rows(base_dir: str | Path) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl
    from .tool_registry import ensure_tools_dir_readonly

    path = ensure_tools_dir_readonly(base_dir) / "pr-lifecycle.jsonl"
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


def merged_row_instant(row: Mapping[str, Any]) -> str:
    """When a merged row's merge happened: GitHub's ``merged_at``, else (rows before it was carried) the record time."""
    return str(row.get("merged_at") or row.get("recorded_at") or "")


def merged_row_is_arias(row: Mapping[str, Any]) -> bool:
    """Whether a merged row's change is ARIA's delivered change.

    Only a row whose lineage says so (review of #1910, N4): a row without one
    is not proof, whoever wrote it.
    """
    return row.get("head_lineage") in ARIAS_LINEAGES


def lineage_credits_aria(lineage: Any) -> bool:
    """Whether learning may credit ARIA for a merge of this lineage (review of #1910, N5)."""
    return lineage in ARIAS_LINEAGES


def lineage_checks(rows: list[dict[str, Any]], pr_number: int) -> int:
    """How many cycles found ``pr_number``'s merged head unreadable."""
    return sum(1 for row in rows if row.get("event") == EVENT_LINEAGE_UNVERIFIED and row.get("pr_number") == pr_number)


def closed_recheck_due(rows: list[dict[str, Any]], pr_number: int, *, now: datetime | None = None) -> bool:
    """Whether a PR last seen closed unmerged is asked again now (review of #1910, L1)."""
    closed = [row for row in rows if row.get("event") == EVENT_CLOSED_UNMERGED and row.get("pr_number") == pr_number]
    if not closed or len(closed) > MAX_CLOSED_RECHECKS:
        return False
    try:
        last = datetime.strptime(str(closed[-1].get("observed_at") or ""), "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    elapsed = ((now or datetime.now(timezone.utc)) - last.replace(tzinfo=timezone.utc)).total_seconds()
    return elapsed >= CLOSED_RECHECK_INTERVAL_SECONDS


def _git(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    from .main_anchor import scrubbed_git_env

    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=workspace, capture_output=True,
                          text=True, check=False, timeout=120, env=scrubbed_git_env(), stdin=subprocess.DEVNULL)


def _patch_id(workspace: Path, base: str, head: str) -> str | None:
    """The patch's id with whitespace kept (review of #1910, N3).

    ``--stable`` ignores whitespace, so a re-indent that moves a statement
    into an ``if`` — a semantic change in Python — read as the same patch;
    ``--verbatim`` hashes the diff as written.
    """
    from .main_anchor import scrubbed_git_env

    diff = _git(workspace, "diff", "--no-color", "--no-ext-diff", f"{base}..{head}")
    if diff.returncode != 0:
        return None
    patch = subprocess.run(["git", "patch-id", "--verbatim"], cwd=workspace, input=diff.stdout, capture_output=True,
                           text=True, check=False, timeout=120, env=scrubbed_git_env())
    return (patch.stdout.split() or [None])[0] if patch.returncode == 0 else None


def classify_merged_head(
    workspace: str | Path | None, *, pr_number: int, delivered_sha: str, head_sha: str, merge_sha: str,
) -> str:
    """The lineage of the head GitHub merged against the head the kernel delivered (module docstring).

    Every git read here — the fetches, the walk, the patch ids — that fails
    or times out gives ``head_unverifiable``, which the reconciler retries
    (review of #1910, L2); nothing escapes into the cycle.
    """
    if head_sha and head_sha == delivered_sha:
        return LINEAGE_DELIVERED
    if workspace is None or not head_sha or not delivered_sha or not merge_sha:
        return LINEAGE_UNVERIFIABLE
    try:
        return _classify(Path(workspace), pr_number=pr_number, delivered_sha=delivered_sha, head_sha=head_sha,
                         merge_sha=merge_sha)
    except (OSError, subprocess.SubprocessError, ValueError):
        return LINEAGE_UNVERIFIABLE


def _classify(checkout: Path, *, pr_number: int, delivered_sha: str, head_sha: str, merge_sha: str) -> str:
    from .branch_update_lineage import BranchUpdateLineageRefused, fetch_pr_head, hermetic_git

    fetch_pr_head(checkout, pr_number)
    _git(checkout, "fetch", "--no-tags", "--quiet", "origin", merge_sha)
    # The base the PR merged INTO: the merge commit's first parent (a merge
    # commit's, a squash's or a rebase's). Review of #1910, N1 — the second
    # parent of a merge-commit merge IS the PR head, so "contained in the
    # merge commit" admits any branch a person merged into ARIA's; only a
    # commit already on the base is a base update.
    base_at_merge = f"{merge_sha}^1"
    try:
        with hermetic_git(checkout) as git:
            if any(git.run("cat-file", "-e", f"{sha}^{{commit}}").returncode != 0
                   for sha in (head_sha, delivered_sha, merge_sha, base_at_merge)):
                return LINEAGE_UNVERIFIABLE
            # Every first-parent step from the merged head back to the
            # delivered tip is a two-parent merge of a commit already on the
            # base, whose tree is the pure merge.
            commit, steps = head_sha, 0
            while commit != delivered_sha and steps < _MAX_WALK:
                parents = git.run("rev-list", "--parents", "-n", "1", commit).stdout.split()[1:]
                if len(parents) != 2:
                    break
                previous, merged = parents
                pure = git.run("merge-tree", "--write-tree", "--no-messages", previous, merged)
                tree = git.run("rev-parse", "--verify", f"{commit}^{{tree}}")
                if (git.run("merge-base", "--is-ancestor", merged, base_at_merge).returncode != 0
                        or pure.returncode != 0 or tree.returncode != 0
                        or (pure.stdout.splitlines() or [""])[0].strip() != tree.stdout.strip()):
                    break
                commit, steps = previous, steps + 1
            if commit == delivered_sha:
                return LINEAGE_BASE_MERGED
    except BranchUpdateLineageRefused:
        return LINEAGE_UNVERIFIABLE
    # A rebase: the delivered patch, unchanged, on a newer base.
    delivered_base = _git(checkout, "merge-base", delivered_sha, base_at_merge).stdout.strip()
    head_base = _git(checkout, "merge-base", head_sha, base_at_merge).stdout.strip()
    if not delivered_base or not head_base:
        return LINEAGE_UNVERIFIABLE
    before, after = _patch_id(checkout, delivered_base, delivered_sha), _patch_id(checkout, head_base, head_sha)
    if before is None or after is None:
        return LINEAGE_UNVERIFIABLE
    return LINEAGE_PATCH_UNCHANGED if before == after else LINEAGE_DIVERGED


def observed_merge(remote: Mapping[str, Any] | None, *, pr_number: int) -> tuple[str, str, str] | None:
    """(merge commit, merged at, merged head) when GitHub reports ``pr_number`` merged, else None."""
    if not isinstance(remote, Mapping) or remote.get("number") not in (None, pr_number):
        return None
    commit = remote.get("mergeCommit") if isinstance(remote.get("mergeCommit"), Mapping) else {}
    merge_sha, merged_at = str(commit.get("oid") or ""), str(remote.get("mergedAt") or "")
    if str(remote.get("state") or "").upper() != "MERGED" or not merge_sha or not merged_at:
        return None
    return merge_sha, merged_at, str(remote.get("headRefOid") or "")


def verify_merge_after_rejection(
    *, opened: Mapping[str, Any] | None, remote: Mapping[str, Any] | None, workspace: str | Path | None,
) -> tuple[str, str, str, str]:
    """(merge sha, merged at, merged head, lineage) when GitHub proves the kernel's PR merged as ARIA's change.

    Raises :class:`MergeNotProven` naming the first fact that does not hold.
    """
    if not isinstance(opened, Mapping) or type(opened.get("pr_number")) is not int or not opened.get("head_sha"):
        raise MergeNotProven("no_opened_row_for_the_plans_change")
    if not isinstance(remote, Mapping):
        raise MergeNotProven("github_unanswered")
    if remote.get("number") not in (None, opened["pr_number"]):
        raise MergeNotProven("github_answered_another_pr")
    merge = observed_merge(remote, pr_number=opened["pr_number"])
    if merge is None:
        raise MergeNotProven("pr_not_merged")
    merge_sha, merged_at, head = merge
    lineage = classify_merged_head(workspace, pr_number=opened["pr_number"], delivered_sha=str(opened["head_sha"]),
                                   head_sha=head, merge_sha=merge_sha)
    if lineage == LINEAGE_UNVERIFIABLE:
        raise MergeLineageUnverified(f"merged_head_unreadable:{lineage}")
    if lineage not in ARIAS_LINEAGES:
        raise MergeNotProven(f"merged_head_is_not_the_delivered_change:{lineage}")
    return merge_sha, merged_at, head, lineage


def _append_lifecycle(pr: Mapping[str, Any], *, event: str, base_dir: str | Path, cycle_id: str | None,
                      extra: Mapping[str, Any], unless: Any) -> bool:
    """Append one lifecycle row for ``pr`` under the ledger's lock, unless ``unless(rows)`` already holds."""
    from .auto_merge import _MERGED_ROW_OWNER, record_pr_lifecycle
    from .ledger import state_transaction
    from .tool_registry import ensure_tools_dir

    path = ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl"
    row = {**record_pr_lifecycle(dict(pr), event=event, cycle_id=cycle_id, _owner=_MERGED_ROW_OWNER), **extra}
    with state_transaction([path]) as transaction:
        rows = transaction.load_declared_jsonl(path, expected_surface="pr_lifecycle") if path.exists() else []
        if unless(rows):
            return False
        transaction.append_declared_jsonl(path, row, expected_surface="pr_lifecycle")
    return True


def record_merge(
    *,
    pr: Mapping[str, Any],
    merged_by: str,
    base_dir: str | Path,
    cycle_id: str | None = None,
    plan_id: str | None = None,
    merge_sha: str | None = None,
    merged_at: str | None = None,
    merged_head_sha: str | None = None,
    head_lineage: str,
    idempotency_key_hash: str | None = None,
    merged_after_rejection: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Record that ARIA's PR ``pr`` merged: its lifecycle row (once) and, for ``plan_id``, the plan's merge.

    ``pr`` is the PR as its observer holds it (the merge lane's GitHub payload,
    or the kernel's own ``opened`` row). The row carries the observed merge
    (``merged_head_sha``, ``merge_sha``, ``merged_at``) beside the delivered
    head and the head's lineage: ``delivered`` from the merge lane (it
    merges at the head it checked), the classified lineage from an observed
    merge, ``backfilled_unverified`` from a plan's own merge facts.
    Idempotent. Returns what was written.
    """
    from .plan_convergence import _record_implementation_merged, fold_plan_state

    if merged_by not in MERGED_BY_VALUES:
        raise ValueError(f"merged_by must be one of {sorted(MERGED_BY_VALUES)}")
    if head_lineage not in LINEAGES:
        raise ValueError(f"head_lineage must be one of {sorted(LINEAGES)}")
    number = pr.get("number", pr.get("pr_number"))
    if type(number) is not int:
        raise MergeNotProven("pr_number_missing")
    extra = {
        "merged_by": merged_by,
        "delivered_head_sha": pr.get("head_sha") or pr.get("headRefOid"),
        **({"merge_sha": merge_sha} if merge_sha else {}),
        **({"merged_at": merged_at} if merged_at else {}),
        **({"head_sha": merged_head_sha} if merged_head_sha else {}),
        "head_lineage": head_lineage,
    }
    written: dict[str, Any] = {"pr_number": number, "plan_event": None}
    written["lifecycle_row"] = _append_lifecycle(
        {**dict(pr), "number": number}, event="merged", base_dir=base_dir, cycle_id=cycle_id, extra=extra,
        unless=lambda rows: any(row.get("event") == "merged" and row.get("pr_number") == number for row in rows),
    )
    if plan_id is None:
        return written
    if fold_plan_state(plan_id=plan_id, base_dir=base_dir).get("state") == "IMPLEMENTATION_MERGED":
        return written
    if not merge_sha or not merged_at or not idempotency_key_hash:
        raise MergeNotProven("plan_merge_needs_sha_time_and_key")
    written["plan_event"] = _record_implementation_merged(
        plan_id=plan_id, merge_sha=merge_sha, merged_at=merged_at, idempotency_key_hash=idempotency_key_hash,
        head_lineage=head_lineage, merged_after_rejection=dict(merged_after_rejection) if merged_after_rejection is not None else None,
        base_dir=base_dir,
    )
    return written


def record_pr_unmergeable(
    *, pr: Mapping[str, Any], event: str, reason: str, base_dir: str | Path, cycle_id: str | None = None,
) -> bool:
    """One observation of a kernel PR that did not merge as ARIA's change.

    ``merge_unproven`` (a merge refused for a named fact) ends the PR's
    lifecycle; ``closed_unmerged`` is re-asked once a day, bounded
    (:func:`closed_recheck_due`); ``merge_lineage_unverified`` counts one
    cycle whose head could not be read (:func:`lineage_checks`).
    """
    if event not in (EVENT_CLOSED_UNMERGED, EVENT_MERGE_UNPROVEN, EVENT_LINEAGE_UNVERIFIED):
        raise ValueError(f"event must be one of {EVENT_CLOSED_UNMERGED}, {EVENT_MERGE_UNPROVEN}, "
                         f"{EVENT_LINEAGE_UNVERIFIED}")
    number = pr.get("number", pr.get("pr_number"))
    ended = ("merged", EVENT_MERGE_UNPROVEN)
    return _append_lifecycle(
        {**dict(pr), "number": number}, event=event, base_dir=base_dir, cycle_id=cycle_id,
        extra={"reason": reason, "observed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        unless=lambda rows: any(row.get("event") in ended and row.get("pr_number") == number for row in rows),
    )


__all__ = [
    "ARIAS_LINEAGES",
    "CLOSED_RECHECK_INTERVAL_SECONDS",
    "EVENT_CLOSED_UNMERGED",
    "EVENT_LINEAGE_UNVERIFIED",
    "EVENT_MERGE_UNPROVEN",
    "LINEAGES",
    "LINEAGE_BACKFILLED_UNVERIFIED",
    "LINEAGE_BASE_MERGED",
    "LINEAGE_DELIVERED",
    "LINEAGE_DIVERGED",
    "LINEAGE_PATCH_UNCHANGED",
    "LINEAGE_UNVERIFIABLE",
    "MERGED_BY_MERGE_LANE",
    "MAX_CLOSED_RECHECKS",
    "MAX_LINEAGE_CHECKS",
    "MERGED_BY_OBSERVED",
    "MergeLineageUnverified",
    "MergeNotProven",
    "classify_merged_head",
    "closed_recheck_due",
    "lifecycle_rows",
    "lineage_checks",
    "lineage_credits_aria",
    "merged_row_instant",
    "merged_row_is_arias",
    "observed_merge",
    "opened_row",
    "record_merge",
    "record_pr_unmergeable",
    "verify_merge_after_rejection",
]
