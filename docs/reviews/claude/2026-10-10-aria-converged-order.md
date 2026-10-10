# Converged plans offered out of order on a clock tie (2026-10-10)

Owner: claude (implementation), okan (review). Deadline 2026-10-17.

## ARIA-MEDIUM-410

`converged_delivery._plan_ledger_scan` returns the CONVERGED plans "oldest convergence first". It
sorted them by the event's `recorded_at`, which has one-second resolution, and broke ties by plan
id. When two plans converge within the same second, the alphabetically first plan is offered
first, whatever order they converged in.

It surfaced as a flaky test: `SweepBoundTests.test_one_re_offer_per_cycle_oldest_convergence_first`
failed on the CI of PR 1932 (suite 8, run 38031162176) with `['plan-new', 'plan-old']`. The
fixture converges both plans back to back, so on a fast runner they share a second, and
`plan-new` sorts before `plan-old`.

Fix: the plan ledger is append-only and written under the plan lock, so an event's position in
it is the order the plans converged in. The scan now orders by that position. A plan that
converges again keeps its latest convergence, as before. The new test
`ConvergenceOrderIsLedgerOrderTests` pins `recorded_at` to one instant and requires
`plan-old, plan-new`. It fails on the old ordering.

## ARIA-MEDIUM-411

Re-running the flaky shard did not clear the check. On PR 1932, run 38031162176, `suite (8)`
passed on attempt 2 at 07:22:22Z. The `aria-kernel` verdict job ran at 07:22:35Z and still read
shard 8 as `successful=False`.

Every attempt uploaded its shard report under one artifact name and one file name. The verdict
job downloads all of a run's artifacts with `merge-multiple: true` into one directory, so the
attempts overwrote each other in an arbitrary order.

Fix:

- Each attempt now uploads its own artifact, `...-attempt-${{ github.run_attempt }}`, with its own
  file, `shard-N.attempt-K.json`.
- The report records `run_attempt`.
- `suite_shards.read_reports` keeps each shard's latest attempt. That is the result GitHub shows
  for that shard's job, because "re-run failed jobs" re-runs only the failed shards.
- A later failed attempt is not hidden by an earlier pass. Two reports for one shard in one
  attempt are both kept, so verify still names the duplicate.
- `RerunAttemptTests` pins all three cases. The invariant in `aria-doc-runtime-ssot.spec.ts`
  pins the new report path.
