# ARIA — the cycle re-opened a PR that already existed (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-408 — pr_lifecycle read "gate passed" as "no PR yet"

## Symptom

Every ARIA auto-cycle after PR 1906 opened (2026-10-09) ended `failed`, with
`failed_phases: [{phase: pr_lifecycle, status: failed}]`. Workflow runs 38012006696 and
38018307736 show it, and so does `cyc-20261010T025128Z-auto` on `aria/state`.

## Evidence

Measured on an archive of `origin/aria/state` (2026-10-10):

- `proposal-cc0c546b-c10b-48fc-9b97-50995d1f0243` (the F-015 plan) is `approved_for_apply`. Its
  latest apply action has been `ready_for_pr` since 2026-10-09T09:59:13Z, on change
  `chg_8c3e6311c4475b1b`.
- `pr-lifecycle.jsonl` has the `opened` row for PR 1906 at 09:59:50Z. The executor's delivery
  wrote it through `pr_manager._create_pull_request`. A `merged` row followed: merge
  `528c63c0d`, `merged_at` 2026-10-10T01:03:06Z, written by `merge_record.record_merge`.
- The phase's candidate loop (`aria-kernel/aria_kernel/cycle.py:3140-3153` before this change)
  skipped only `IN_FLIGHT_APPLY_STATUSES` (`apply_engine.py:49`). So the proposal stayed a
  candidate, and `open_pr_for_action(dry_run=True)` ran on every cycle.
- Running that call against the archived state with a fresh checkout as the workspace
  reproduces the refusal: `open_pr_head_sha_unresolvable: git rev-parse
'aria-impl-7c52b7f387ab21ab5550aa4148a71306' failed with returncode=128`
  (`pr_manager.py:417`). The executor's local branch does not exist on a fresh runner. Even
  where it did exist, the preview would have reported "openable" for a PR that had already
  merged.
- `ok < total` makes the phase `fail` (`cycle.py:3229`), and the cycle propagates that to its
  terminal row.

## Root cause

Two ledgers each looked like they owned "does this change have a PR?":

- **The apply action.** `ready_for_pr` is the validation gate's verdict on the change. It stays
  true after a PR opens. Nothing advances it, and the executor lane, the operator CLI and the
  merge observer all leave it as it is.
- **The pr-lifecycle ledger.** It is the real owner of the PR. The single `gh pr create` writes
  `opened` (`pr_manager.py:823`), whichever lane asked for the PR. `merge_record` writes `merged`
  and `closed_unmerged` (`merge_record.py:301`, `:361`).

The phase read the first ledger as if it answered the second question.

## Fix (tier 1: the wrong candidacy cannot be computed)

The candidacy question now goes to the ledger that owns the answer.
`merge_record.pull_requests_for_change` returns the kernel PRs opened for the change that a
proposal's latest apply action names, and the lifecycle state of each one (`open`, `merged`,
`merge_unproven`, `merge_lineage_unverified`, `closed_unmerged`). It reads the pr-lifecycle
ledger only.

`_run_pr_lifecycle_phase` treats a change that has any such PR as delivered. The phase reports
it under `delivered` and never counts it, and it never calls `open_pr_for_action` for it.

A PR that was closed without merging is that delivery's outcome. It is not a reason to open a
second PR for the same change. A new attempt is a new staging, which gets a new change id, and
that new change is still a candidate.

Binding works the same way the implementation reconciler binds a plan to its PRs: by the
action's `change_id`. An operator-lane action has no change id, because `plan_apply_worktree`
does not mint one, so it binds by proposal. That lane has one branch per proposal.

### Rejected alternative

Advancing the apply action or the proposal on PR open, merge and close would have meant two
more writers holding a copy of a fact that the pr-lifecycle ledger already records. Every
lane that opens or observes a PR would also have had to remember to update them. That is the
second-copy drift this defect came from.

### Existing state

No hand edit or extra append is needed. `aria/state` already holds the `opened` and `merged`
rows for PR 1906, so the next cycle classifies the proposal as delivered. Re-running the phase
against the archived state returns `status: no_op` with `delivered: [{proposal
cc0c546b, change chg_8c3e6311c4475b1b, PR 1906 merged}]`.

## Validation

`aria-kernel/tests/test_cycle_pr_lifecycle_phase.py`, class
`APullRequestThatExistsIsNotACandidate`, covers these cases:

- The live shape: a `ready_for_pr` action, a PR opened by the executor's writer, and the merge
  recorded by `record_merge`.
- A PR that is open and not merged.
- A PR closed without merging.
- A PR for an older change of the same proposal, which does not hide the newer change.
- A delivered proposal next to an undelivered one.
- An operator-lane action that has no change id.

## Not done

The seven other `approved_for_apply` proposals on `aria/state` sit in
`staged_for_implementation`. They are reported as in flight and are not counted. Whether any
of those stagings is abandoned is a separate question, and this finding does not cover it.
