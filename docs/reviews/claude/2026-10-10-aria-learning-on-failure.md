# ARIA — a failed night still learns (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-420 — the orchestrator's failed exits wrote no reflection

### Symptom

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z), each of the 22 cycles that
completed since 2026-10-01 has a row in `reflections.jsonl`. None of the 5 failed cycles has one:
`cyc-20261009T104405Z`, `cyc-20261009T152747Z`, `cyc-20261009T210245Z`,
`cyc-20261010T011101Z` and `cyc-20261010T025128Z`, all failed on `pr_lifecycle`. On those
nights ARIA wrote no daily report and queued no next-cycle work. Those were the nights whose cause
most needed to reach the next cycle.

### Evidence

- `aria_kernel/autonomy_orchestrator.py:1780-1785` (base 2b8385600): `cycle_status == "failed"`
  with `fail_closed_on_cycle_failure` → `per_cycle_results.append` → `break`.
- `aria_kernel/autonomy_orchestrator.py:1874-1897`: `bridge_replay_required` → `append` →
  `break`.
- The cycle runs with `defer_reflection=True` (`:1724-1729`), so the in-cycle `reflection` phase
  is always skipped by its `REFLECTION_NOT_DEFERRED` precondition. The orchestrator's post-drain
  exits (`:2079-2091`, `:2115-2127`, `:2263-2275`, `:2364-2381`, `:2692-2704`, `:2901-2913`) are
  therefore the only writers of the row.

### Root cause

V3.3 §2b moved reflection from the cycle into the orchestrator's post-drain exits. The two exits
that break before the drainers did not get it, so a failed night had no reflection writer at all.

### Fix (tier 2: the reflection is automatic on every exit)

- `_reflect_on_failed_cycle` uses the post-drain shape the no-pressure exit already uses:
  `convergence_result=None`, `review_result=None`, `producer_reflection_kwargs`. Both failed
  exits call it before `per_cycle_results.append`. The work lanes are still skipped.
- The pedagogy snapshot is taken once, before the fail-closed branch, so every exit reports the
  same scan.
- Reflection is more than observation. It writes the daily report and queues the cycle's
  schedulable pressures (`reflection.py:206-245`). On a failed night that queueing is the
  intended self-repair entry.
- `tests/test_failed_cycle_reflection.py` drives the real orchestrator through three exits: the
  production-shaped payload failure (the runner returned and `pr_lifecycle` failed), a crash, and
  `bridge_replay_required` under `strict`. On each it pins one reflection row that names the failed
  cycle, the queued pressure, and that planner and worker did not run. All three tests fail on the
  base (0 rows) and pass with the fix.
- The shape was agreed with `notify` (PR-3), who adds the operator notification. That
  notification goes out before this reflection, so a reflection that raises cannot swallow it.

### Production evidence

`run_reflection` was run in this exact shape for `cyc-20261010T025128Z` on a copy of the archive,
with the store's bound repo root and the archive's `findings/` as `ARIA_REPO_STATE_ROOT`. It
returned normally and wrote the row (14 tool runs, 0 failed) and `reports/daily/2026-10-10.md`. Its
`next_cycle_plan` named 2 pressures (`pressure:migration-surface-repeat:repetition`,
`pressure:runtime-signal:unknown`). Both were already pending, because `pressure_id` is the queue's
idempotency key (`next_cycle_queue.py:180-190`), so the night added no new row.

### Not done here

- A reflection that raises still propagates out of the orchestrator, as it does on the six
  existing exits. This happens when a ledger that `run_reflection` reads strictly fails
  verification. Catching it would hide a store that cannot be verified. The operator notification
  has already been sent by then.
- The archive's next-cycle queue is at its depth cap: 32 pending rows against `DEFAULT_QUEUE_DEPTH` 32. Several are duplicates written before the C10 dedupe, for example 8 rows for
  `pressure:migration-surface-repeat:repetition` from cycles 2026-09-19..10-07. A pressure that is
  genuinely new to a failed night would be overflow-blocked. That block is visible
  (`next_cycle_queue_overflow_blocked`), but no work gets queued. Draining or deduping the stale
  rows is not in this PR's plan section; it is reported to `main` for registration.
