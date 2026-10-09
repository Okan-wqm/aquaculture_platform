# ARIA: "merged" has one owner

- **Date:** 2026-10-09
- **Reviewer:** claude (Lane B)
- **Finding:** ARIA-HIGH-390

## How a person's merge flowed on main before this change

The live case is PR #1906, F-015's implementation. Its plan
`plan-cyc-20261008T175911Z-auto` was IMPLEMENTATION_RECORDED and the PR was labelled
`aria:human-merge`.

- **The plan ledger:** `implementation_reconciler` read GitHub and wrote `implementation_merged`,
  but only for plans resting in IMPLEMENTATION_RECORDED. The same pass promoted the convention and
  closed the finding (ARIA-HIGH-363).
- **`pr-lifecycle` `merged`:** written only by `merge_authority`, so only for merges ARIA's own
  merge lane performed.
  - A person's merge left no row.
  - `change_outcome` refuses every outcome without one (`change_outcome_requires_merged_change`).
  - Change intelligence (`pr_tracking.ingest_merged_pr_lifecycle`) never saw the merge.
- **`ci/merge-outcomes.jsonl`:** `own_pr_ci` reads merged own PRs from GitHub for the post-merge CI
  verdict. This is a different fact and is unchanged.
- **A plan the kernel ended after its PR existed** (a result refused after delivery,
  ARIA-HIGH-389, or a reaped orphan) reached neither. A person's merge of its PR was only a resolved
  HUMAN_REQUIRED record, and its finding never closed.

## ARIA-HIGH-390: the fix

`aria_kernel/merge_record.record_merge` is the only writer of both facts, and it writes them
together:

- the PR's `pr-lifecycle` `merged` row, once per PR;
- for a plan, its `implementation_merged` event.

It has two callers, the two observers of a merge:

- `merge_authority`, when ARIA's lane merged the PR or the merge queue settled the merge;
- `implementation_reconciler`, the one reader of GitHub truth for ARIA's PRs.

An AST invariant in `tests/test_merge_record.py` fails the build when anything else calls
`record_implementation_merged` or `record_pr_lifecycle(event="merged")`.

**A rejected plan folds MERGED only on an observed merge of its own PR.**

- The kernel's own `opened` row for the change the plan minted.
- GitHub reporting that PR MERGED, with a merge commit.
- A merged head equal to the head the kernel recorded when it opened the PR.

The owner checks all three. The reducer allows REJECTED → MERGED only when the event names the
plan's own rejection, of a class in `MERGEABLE_AFTER_REJECTION`
(`implementation_result_refused_after_delivery`, `orchestrator_restart_reaped_orphan`). A payload
alone proves nothing, and the tests refuse every forgery: wrong head, PR not merged, another PR, a
PR opened for another change, the wrong class, and no claim at all.

**A plan merged before the owner existed** has its PR's lifecycle row backfilled once from the
plan's own merge, with no GitHub read. That covers #1906 if it merges before this change deploys.

`github_adapters.pr_merge_state` now also returns `headRefOid`.
