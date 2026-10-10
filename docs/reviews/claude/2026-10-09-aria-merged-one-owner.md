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

## Review corrections (adversarial review of #1910)

- **F1 HIGH, closed: a person's commits were credited to ARIA.**
  - The merged row now carries what GitHub observed: the merged head, `merge_sha` and `merged_at`,
    beside `delivered_head_sha` and the head's lineage (`merge_record.classify_merged_head`).
  - Lineages:
    - `delivered`: the same commit.
    - `base_merged`: every later commit is a pure two-parent merge of a commit the merge contains,
      GitHub's update-branch, which is #1906's case under strict.
    - `patch_unchanged`: the delivered patch, rebased.
    - `head_diverged` or `head_unverifiable`: anything else.
  - `change_outcome` refuses a diverged merge (`change_outcome_merge_head_diverged`, or a
    `merge_head_diverged` skip in the nightly selection). `pr_tracking` does not carry it into
    impact learning.
  - The REJECTED path accepts exactly the ARIA lineages. This also closes F5: an update-branch merge
    is no longer refused forever.
- **F2, closed:** `change_outcome` and `pr_tracking` anchor on the row's `merged_at`
  (`merge_record.merged_row_instant`). A backfill carries the plan's own `merge_sha` and
  `merged_at`.
- **F3, closed:** a backfill without the kernel's `opened` row is skipped and reported, never
  written degraded.
- **F4, closed (tier 1 + tier 3).**
  - The plan event's writer is private (`plan_convergence._record_implementation_merged`).
  - `auto_merge.record_pr_lifecycle` refuses the owned events (`merged`, `closed_unmerged`,
    `merge_unproven`) without the owner token `_MERGED_ROW_OWNER`, which only `merge_record`
    imports.
  - `tests/invariants/test_merged_single_writer.py` catches every bypass the review named: an
    import, alias or `getattr` string of either private name, a `**` splat or non-literal event, an
    `implementation_merged` event type handed to a writer, and a direct `pr_lifecycle` append. It
    self-tests on a forged module.
- **F6, closed:** `agent_eval`'s merged episode supersedes the rejected one when the merge
  followed a rejection. `finding_grounding` drops `failed_at` and `unverified_failed_at` once the
  plan merged.
- **F7, closed:** a PR GitHub reports CLOSED unmerged, or whose merge was refused once, gets a
  `closed_unmerged` or `merge_unproven` lifecycle row and is not asked about again. Every opened row
  of the plan's change is asked about, so a later one no longer shadows the first.
- **F8, closed:** the check and the append run under the `pr-lifecycle` ledger lock.
- **F9, closed:** reads use `ensure_tools_dir_readonly`. The queue-settled path names the PR it
  dequeued, so a payload without its number never loses the row.
- **F10, closed:** the reducer ties `merged_after_rejection.pr_number` to the PR the post-delivery
  settlement named.

## Re-review corrections (re-review of #1910 at 32584f862)

- **N1 HIGH, closed: a person's branch merged into ARIA's passed as `base_merged`.**
  - `classify_merged_head` tested each update merge's second parent for ancestry against the merge
    commit itself. With the merge-commit method (`allow_merge_commit` is on), the merge commit's
    second parent IS the PR head, so any branch merged into ARIA's counted as "contained".
  - Ancestry is now tested against the base at the merge, `merge_sha^1`: the first parent of a merge
    commit, a squash or a rebase. Only a commit already on the base is a base update.
  - Probe S1 is pinned for both merge methods. The earlier lineage tests merged with `--no-ff` and
    so hid it.
- **N2, closed:** `head_unverifiable` is no longer terminal.
  - Any failed or timed-out read is counted as a `merge_lineage_unverified` lifecycle row and asked
    again next cycle.
  - At `MAX_LINEAGE_CHECKS` (6) the outcome is disclosed. A REJECTED plan's PR becomes
    `merge_unproven` (`merged_head_unreadable:…:after_6_checks`). A RECORDED plan's merge is
    recorded as GitHub reports it, with lineage `head_unverifiable`, which no reader credits.
  - Only `head_diverged`, or another named fact, ends a PR's lifecycle.
  - Known limit: the auto-cycle runs once a day, so the six checks span about six days. If the
    merged head stays unreadable for that long, a REJECTED plan's merge is refused for good. The
    ending is disclosed (`after_6_checks`) and fails closed: nothing is credited.
- **N3, closed:** `patch-id --verbatim` replaces `--stable`. A re-indent that moves a statement into
  an `if` is no longer "the delivered patch" (probe S3, pinned).
- **N4, closed:** every merged row names its lineage; `record_merge` requires one from the
  vocabulary.
  - A backfill writes `backfilled_unverified`.
  - Only the merge lane writes `delivered` without a classification, because it merges at the head
    it checked (directly, or settled by the queue at the enqueued head).
  - `merged_row_is_arias` credits only `delivered`, `base_merged` and `patch_unchanged`. A row
    without a lineage is not ARIA's, so #1906 merged before this deploys is never credited.
- **N5, closed:** `implementation_merged` carries `head_lineage`.
  - The plan still folds MERGED, which is GitHub's truth.
  - Convention promotion (`_reconcile_promotion` reports `not_credited`) and the implementer's
    merged episode in `agent_eval` both skip any lineage that is not ARIA's.
- **L1, closed:** `closed_unmerged` is not terminal. A PR closed unmerged is asked again once a day,
  at most `MAX_CLOSED_RECHECKS` (14) times, so a reopen-and-merge is seen. A reopen writes no
  `opened` row.
- **L2, closed:** every git read in the classification (both fetches, the walk, the patch ids) runs
  inside the guard. `TimeoutExpired` or any `SubprocessError`/`OSError` gives `head_unverifiable`,
  which is retryable and never aborts the cycle.
- **L3, accepted as defence in depth:**
  - The AST invariant catches the bypasses a reviewer would write by accident: an import, an alias,
    a `getattr` literal, a splat, a non-literal event, a direct append.
  - A name built at runtime by string concatenation is not caught, and the runtime guard does not
    stop it either: the `_MERGED_ROW_OWNER` token `record_pr_lifecycle` checks can itself be fetched
    with `getattr(module, "_MERGED_ROW" + "_OWNER")`. Writing that takes deliberate evasion, which
    review is expected to catch, so this stays LOW.
- **L4, closed:** `pr_tracking` ingests every merged row of an ARIA PR. A row whose lineage is not
  ARIA's is carried with `attributed_to_aria: false`, so impact analysis sees the change and nothing
  downstream credits ARIA for it.
