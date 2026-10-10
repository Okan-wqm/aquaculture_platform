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
  rows is not in this PR's plan section. It is ARIA-MEDIUM-428 (stub to `main`, owner claude,
  deadline 2026-10-24).

## ARIA-MEDIUM-421 — an executed reproduction never became a belief

### Symptom

The archive's `experiments/observations.jsonl` holds 63 rows, and exactly one matched its
contract with a red run: `exp-auto-f-020` → F-020, cycle `cyc-20261008T151306Z`, recorded
15:56:12Z. `memory/beliefs.jsonl` (237 rows) holds no `finding-reproduced-*` belief. The
experiment lane confirmed the finding (E21-c), but memory never learned it.

### Evidence

- `aria_kernel/memory.py:194` (base 2b8385600): `update_memory` calls the writer, so it runs in
  the `memory` phase.
- `aria_kernel/cycle.py:3381` and `:3516` (base): `memory` runs before `experiment_night`, which
  writes the observations.
- `aria_kernel/memory.py:1630` (base): the writer keeps only `row.cycle_id == cycle_id`.
- That cycle's memory phase wrote its rows at 15:28:41Z, 27 minutes before the reproduction
  existed. None of the 8 later cycles on the archive passes the filter.

### Root cause

The only reader of the bench's output ran before the bench, and it was keyed on "this cycle". The
reproduction landed after the only reader that would ever look at it.

### Fix (tier 1: the reader runs after the writer and cannot miss a row)

- `memory.record_experiment_reproduction_beliefs` is the new post_tool phase
  `experiment_beliefs`, registered directly after `experiment_night`. It is `WRITES_PERMITTED`,
  standard-only and `record_and_continue`, like the bench. Belief writing stays in memory.py (İ1).
  The frozen-profile gate `update_memory` applied (`enforce_profile_for_write("observation")`)
  moves with it. `update_memory` no longer calls the writer.
- The filter is now "a matched-red, finding-bound observation that memory has not answered yet",
  keyed on the observation's `validation_run_id`. A belief row that cites the run
  (`source_validation_run_id`, new optional field) answers it. So does an uncertainty row that
  names why no belief could be written. A night whose job deadline skipped the phase loses
  nothing. Each run is answered exactly once, and a new reproduction re-supports the belief.
- The repo-evidence policy is asked before the write. A refusal (scope files gone from HEAD) is
  recorded once as an uncertainty, so a backlog reader cannot fail the phase every night. The
  observations ledger is now read strictly. An unreadable ledger fails the phase instead of
  reading as "nothing reproduced".
- The private `_record_experiment_reproduction_beliefs` stays the worker that the bridge tests
  call. The public function adds the gate and the store root.
- Tests: `tests/test_experiment_finding_bridge.py` replaces the test that pinned the defect
  (`test_memory_leg_ignores_other_cycles_and_green_runs`) with three tests: an earlier cycle's
  reproduction, exactly once plus re-support, and refusal answered once. All three fail on the
  parent (0 ≠ 1; KeyError on the missing provenance; the GovernanceError escapes).
  `tests/test_experiment_beliefs_phase.py` covers the table position, the same-night path through
  the real phase runner, and the frozen gate. Its import fails on the parent: there is no phase.
  The pins at `test_x2_experiment_author.py:194-201` and `test_change_outcome.py:395-406` are kept
  (index order only).

### Production evidence

`record_experiment_reproduction_beliefs` was run for `cyc-20261010T080114Z` on a copy of the
archive (workspace = this checkout, `ARIA_REPO_STATE_ROOT` = the archive's `findings/`). It wrote
`finding-reproduced-f-020`:

- `supported` / `verified`, confidence 0.755;
- evidence `apps/alert-engine/src/rules-engine/safe-regex.util.ts`;
- `source_validation_run_id` `vrun-34f42790552f93ae`.

A second night wrote 0. No uncertainty was needed.

### Not done here

- An observation whose experiment row is missing, or whose experiment has no `finding_ref`, is
  not a finding reproduction. It is passed over each night with no row written, as before.
- If an operator has withdrawn the belief, `_record_belief` returns the withdrawn row unchanged.
  That run is then re-read each night and counted in `beliefs_written`, a miscount that predates
  this change. There are 0 such beliefs on the archive.
- The plan's #1906 check (does it appear in change_outcome/reflection on the first cycle after
  PR-7) can only be made on a live night. It stays with `main`.
