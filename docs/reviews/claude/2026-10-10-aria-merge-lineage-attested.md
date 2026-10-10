# ARIA: the first merge was never credited (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-409 — a merge recorded without a lineage stays uncredited forever

## Symptom

PR 1906 was ARIA's first merged PR. It belongs to plan `plan-cyc-20261008T175911Z-auto`,
change `chg_8c3e6311c4475b1b`, finding F-015. A person merged it at 2026-10-10T01:03:06Z with
merge `528c63c0d`. Nothing in ARIA credits it:

- `merge_record.merged_row_is_arias` returns False for its `merged` row.
- `implementation_reconciler._reconcile_promotion` returns `not_credited`.
- `agent_eval` drops the implementer's merged episode.
- `pr_tracking` ingested the merge as `attributed_to_aria: false`.

## Evidence

Measured on `origin/aria/state` (2026-10-10):

- `tools/plans/events.jsonl`: `implementation_merged` for the plan, recorded 01:28:02Z, payload
  `{merge_sha, merged_at, idempotency_key_hash}` with no `head_lineage`. The cycle that wrote it
  ran pre-#1910 code (see "Who ran the 01:08Z cycle").
- `tools/pr-lifecycle.jsonl`: the `merged` row for PR 1906, recorded 03:08:51Z by the first
  cycle on #1910. It has `head_lineage: backfilled_unverified`, and its `head_sha` is the
  delivered head `1ac2048c`, not the merged head.
- `tools/merge-events.jsonl`: PR 1906 ingested with `attributed_to_aria: false`.
- The merged head is `422cd088`, the merge commit's second parent. It sits three
  `Merge branch 'main' into aria-impl-...` commits above the delivered `1ac2048c`. Run against a
  checkout, `classify_merged_head(pr_number=1906, delivered_sha=1ac2048c, head_sha=422cd088,
merge_sha=528c63c0d)` returns `base_merged`, which is one of ARIA's lineages.

Code on main before this change:

- `aria-kernel/aria_kernel/implementation_reconciler.py:215-240`: `_backfill_lifecycle` writes
  the row from the plan's own merge facts and stamps `backfilled_unverified`. It never reads the
  head (review of #1910, N4: "no head is classified here").
- `aria-kernel/aria_kernel/merge_record.py:124-135`: `merged_row_is_arias` and
  `lineage_credits_aria` credit only the lineage a row or event carries. Nothing could ever
  supply a lineage later.
- `aria-kernel/aria_kernel/merge_record.py:374-380`: `record_pr_unmergeable` refuses a
  `merge_lineage_unverified` row once a `merged` row exists. A backfilled merge therefore could
  not even enter the N2 retry.
- `aria-kernel/aria_kernel/agent_eval.py:977`: the merged episode is skipped unless the
  `implementation_merged` event itself names an ARIA lineage.
- `aria-kernel/aria_kernel/implementation_reconciler.py:243-247`: the promotion reads the plan's
  `head_lineage`, which was absent.

## Root cause

The merge's lineage had one chance to be classified: when the merge was first recorded. A merge
recorded by code that could not classify it got a fail-closed stamp, either
`backfilled_unverified` or no lineage at all. Ledgers are append-only memory surfaces
(`memory_class.refuse_history_rewrite`), so nothing can change that stamp. No reader had a
second source to consult. Fail-closed was correct for an unread head. Making it permanent for a
head that is readable is the defect.

## Fix

One owner and one classifier. Nothing is rewritten and every reader folds the attestation.

- `merge_record.attest_merge_lineage` (`merge_record.py:464`) is the owner. It records the
  classified lineage of a merge that was recorded without one:
  - If there is no `merged` row, it writes the row with the lineage. This is the backfill, and
    it now classifies.
  - If the row is `backfilled_unverified`, it appends one `merge_lineage_attested` row that
    carries the head lineage, `merged_head_sha`, `delivered_head_sha` and `merge_sha`.
  - If the plan's `implementation_merged` named no lineage, it appends one
    `implementation_merge_lineage_attested` plan event.
  - A classified lineage is never replaced (`UNCLASSIFIED_LINEAGES`, `fold_lineage`), and an
    attestation of another merge commit is refused.
- `plan_convergence`: the new annotation event (`EVENT_TYPES`). `_validate_event` checks its
  shape. `_require_lineage_attestable` allows it only on an IMPLEMENTATION_MERGED plan, for that
  plan's own merge commit, once, and only over a missing lineage. The reducer folds it into
  `implementation.head_lineage`. The private writer
  `_record_implementation_merge_lineage_attested` has an idempotency key on the merge commit
  alone.
- `implementation_reconciler._settle_merged_lineage` (`implementation_reconciler.py:217`)
  replaces `_backfill_lifecycle`. For every merged plan whose row or plan event is unclassified,
  it asks GitHub for the merged head and calls `classify_merged_head`. GitHub must report the
  plan's own merge commit. Then it calls the owner.
  - An unreadable head follows N2: one `merge_lineage_unverified` row per cycle (now also
    counted after a backfilled `merged` row, via `_lineage_settled`). At `MAX_LINEAGE_CHECKS`
    it is attested `head_unverifiable`, which no reader credits.
  - An unreadable GitHub waits without counting a check.
  - A row that is already classified attests its plan without a read.
  - Settlement runs before promotion and finding closure, so the same pass learns from it.
- Readers fold the attestation:
  - `fold_merged_rows`, used by `change_outcome._merge_index` and
    `pr_tracking.ingest_merged_pr_lifecycle`. The ingest key stays the merged row's own head, so
    an attestation ingests nothing twice.
  - `attested_plan_lineages` and `fold_lineage`, used by `agent_eval._performance_episodes`.
    The episode is still the merge event's, one per merge.
  - `fold_plan_state`, used by `_reconcile_promotion`.
  - Readers that count merges filter `event == "merged"` (`report.py`, `change_outcome`
    re-assessment), so the attestation row adds no merge.
- `auto_merge._OWNED_LIFECYCLE_EVENTS` closes `merge_lineage_attested` to the owner.
  `tests/invariants/test_merged_single_writer.py` pins:
  - the new private writer;
  - the literal-event rule for the new lifecycle event;
  - the new plan event type;
  - a new rule that every module calling `merged_row_is_arias` or `lineage_credits_aria` also
    calls one of the folds.

Tiers, stated exactly:

- **Lifecycle row: tier 1.** `record_pr_lifecycle` refuses `merge_lineage_attested` at runtime
  without `auto_merge._MERGED_ROW_OWNER`, so no other module can write it.
- **Plan event: tier 3 at the writer, tier 1 at the fold.** The plan event has no runtime owner
  token. `_record_implementation_merge_lineage_attested` is private only by name, and
  `test_merged_single_writer` matches literal names and literal event types. The adversarial
  review of PR 1932 showed that `pc._mutate(event_type=<built string>)` and
  `getattr(pc, "_record_" + ...)` both pass that invariant. The reducer is therefore the last
  guard against a hand-appended plan event: `_require_lineage_attestable` runs in `_apply_event`
  on every fold, so a forged, replayed or contradicting attestation makes the plan unfoldable
  rather than credited. The same gap already existed for `implementation_merged`, and this
  change does not widen or close it.
- **Readers: tier 3** (the fold invariant).

## Review of PR 1932 (adversarial), fixed in the same PR

- **F1 (MEDIUM): the writer and the fold disagreed on a row with no merge commit.**
  - The owner accepted a recorded `merged` row whose `merge_sha` is None. The fold only applied
    an attestation whose `merge_sha` was None or equal to the row's.
  - Result: the plan was credited, the folded row stayed `backfilled_unverified`, and every
    cycle re-read GitHub and reported a no-op attestation. `_lineage_settled` treated the
    unapplied attestation row as settled, so an unreadable head stopped counting at one check
    and never reached `MAX_LINEAGE_CHECKS`.
  - Fix: one predicate, `merge_record.attestation_binds`. A PR merges once, so a row naming no
    merge commit is bound by its PR, and a row naming one is bound only by that commit. The
    owner, the fold and the reconciler's pre-check all use it.
  - `_lineage_settled` now judges the folded rows, so an attestation the fold would not apply
    settles nothing.
- **F2 (LOW): a classified plan lineage was ignored when the row was missing or unclassified.**
  - The reconciler re-read GitHub instead. In the probe, a plan at `head_diverged` with GitHub's
    head equal to the delivered head ended with a credited `delivered` row.
  - Fix: the reconciler reuses the plan's classified lineage without a read, as it already did
    in the row-to-plan direction.
  - The owner now refuses, by name (`lineage_disagrees_with_the_plan_or_row`), any attestation
    that contradicts a classified lineage on either side. A classified non-ARIA lineage can
    never be upgraded.
- **Surviving mutations M5 (the reducer accepts an attestation over a classified lineage) and M11
  (the reducer check is removed).** Three reducer tests now hand-append the plan event and
  require the fold to refuse it: over a classified lineage, a replay, and another merge commit.
  Both mutations are now killed (M5: 2 failures, M11: 3).
- **Nit:** the comment citing ARIA-HIGH-411 now cites ARIA-HIGH-409.

## Not changed

`tools/merge-events.jsonl` keeps PR 1906's ingested `attributed_to_aria: false`. It is an
append-only ledger, and no production reader consumes that field (only tests do). New ingests
fold the attestation.

## Who ran the 01:08Z cycle

Run 38012006696 (`aria-auto-cycle`, `workflow_dispatch`, `github-actions[bot]`, head
`528c63c0d`) was dispatched by the `chain-next-cycle` job of executor run 37997475930. That run
started 2026-10-09T22:07Z on `5df672355`, and its executor job ended 01:08:34Z. The job runs
`gh workflow run aria-auto-cycle.yml --ref main` (`.github/workflows/aria-agent-executor.yml:1041`),
which resolves `main` at dispatch time. At 01:08Z that was the PR 1906 merge commit itself.
PR 1910 (`fc12b9ae7`) landed 02:46Z. The next cycle, 38018307736 (dispatched by a person at
02:48Z on `fc12b9ae7`), wrote the backfilled row at 03:08Z.

This is no dispatcher defect. Every cycle runs whatever `main` is when it starts. The skew can
recur whenever the meaning of a recorded fact changes between the cycle that records it and a
later version of the code. The 01:08Z cycle lasted until 02:06Z, a window in which main moved.
The answer that removes the class is in the data, not in pinning versions. A fact recorded
fail-closed by older code stays re-classifiable by the current owner through an append-only
attestation. That is what this change does for merge lineage.
