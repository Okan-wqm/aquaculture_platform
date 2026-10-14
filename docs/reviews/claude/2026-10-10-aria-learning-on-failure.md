# ARIA — a failed night still learns (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-420 — the orchestrator's failed exits wrote no reflection

### Symptom (ARIA-HIGH-420)

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z), each of the 22 cycles that
completed since 2026-10-01 has a row in `reflections.jsonl`. None of the 5 failed cycles has one:
`cyc-20261009T104405Z`, `cyc-20261009T152747Z`, `cyc-20261009T210245Z`,
`cyc-20261010T011101Z` and `cyc-20261010T025128Z`, all failed on `pr_lifecycle`. On those
nights ARIA wrote no daily report and queued no next-cycle work. Those were the nights whose cause
most needed to reach the next cycle.

### Evidence (ARIA-HIGH-420)

- `aria_kernel/autonomy_orchestrator.py:1780-1785` (base 2b8385600): `cycle_status == "failed"`
  with `fail_closed_on_cycle_failure` → `per_cycle_results.append` → `break`.
- `aria_kernel/autonomy_orchestrator.py:1874-1897`: `bridge_replay_required` → `append` →
  `break`.
- The cycle runs with `defer_reflection=True` (`:1724-1729`), so the in-cycle `reflection` phase
  is always skipped by its `REFLECTION_NOT_DEFERRED` precondition. The orchestrator's post-drain
  exits (`:2079-2091`, `:2115-2127`, `:2263-2275`, `:2364-2381`, `:2692-2704`, `:2901-2913`) are
  therefore the only writers of the row.

### Root cause (ARIA-HIGH-420)

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

### Production evidence (ARIA-HIGH-420)

`run_reflection` was run in this exact shape for `cyc-20261010T025128Z` on a copy of the archive,
with the store's bound repo root and the archive's `findings/` as `ARIA_REPO_STATE_ROOT`. It
returned normally and wrote the row (14 tool runs, 0 failed) and `reports/daily/2026-10-10.md`. Its
`next_cycle_plan` named 2 pressures (`pressure:migration-surface-repeat:repetition`,
`pressure:runtime-signal:unknown`). Both were already pending, because `pressure_id` is the queue's
idempotency key (`next_cycle_queue.py:180-190`), so the night added no new row.

### Not done here (ARIA-HIGH-420)

- Review of 0c9fd8f35 (dedupe, confirmed): a ledger that fails strict verification made the
  failed-exit reflection raise `LedgerIntegrityError` out of the orchestrator. That night lost its
  return value and its `autonomy_orchestrator_exit` row, both of which the parent kept. Fixed in
  the follow-up commit. On the two failed exits only, `_reflect_on_failed_cycle` catches exactly
  that class: the verified reader is the one owner of "this ledger cannot be trusted". It records
  the refusal in two places:
  - an autonomy-state row `failed_cycle_reflection_refused`, written by the same writer, on the
    same ledger, as that night's `cycle_completed` row (reflection never reads that ledger);
  - the summary (`status: refused`, the error scrubbed and ≤300 chars).

  Review of 5aadb57e0 (dedupe, confirmed): the published error kept the absolute path of a
  ledger outside the store, for example the committed findings' `finding-events.jsonl` under the
  workspace or `ARIA_REPO_STATE_ROOT`. Fixed in the next commit: store paths become
  store-relative, and any other absolute path becomes its file name. The refusal can also come
  from the reflection's own queue append, after its row exists; the error names the ledger
  either way.

  The exit then proceeds as on the parent. Gating the reflection on `integrity_failed` or
  `verify_integrity` was rejected: those verdicts cover run artifacts and the cycle lifecycle, which
  reflection does not read and which drift on exactly the crash nights this finding is about.
  Anything else still raises, as on the six ok/degraded exits.

- The archive's next-cycle queue is at its depth cap: 32 pending rows against
  `DEFAULT_QUEUE_DEPTH` 32. Several are duplicates written before the C10 dedupe, for example 8
  rows for `pressure:migration-surface-repeat:repetition` from cycles 2026-09-19..10-07. A
  pressure that is genuinely new to a failed night would be overflow-blocked. That block is visible
  (`next_cycle_queue_overflow_blocked`), but no work gets queued. Draining or deduping the stale
  rows is not in this PR's plan section. It is ARIA-MEDIUM-428 (stub to `main`, owner claude,
  deadline 2026-10-24).

## ARIA-MEDIUM-421 — an executed reproduction never became a belief

### Symptom (ARIA-MEDIUM-421)

The archive's `experiments/observations.jsonl` holds 63 rows, and exactly one matched its
contract with a red run: `exp-auto-f-020` → F-020, cycle `cyc-20261008T151306Z`, recorded
15:56:12Z. `memory/beliefs.jsonl` (237 rows) holds no `finding-reproduced-*` belief. The
experiment lane confirmed the finding (E21-c), but memory never learned it.

### Evidence (ARIA-MEDIUM-421)

- `aria_kernel/memory.py:194` (base 2b8385600): `update_memory` calls the writer, so it runs in
  the `memory` phase.
- `aria_kernel/cycle.py:3381` and `:3516` (base): `memory` runs before `experiment_night`, which
  writes the observations.
- `aria_kernel/memory.py:1630` (base): the writer keeps only `row.cycle_id == cycle_id`.
- That cycle's memory phase wrote its rows at 15:28:41Z, 27 minutes before the reproduction
  existed. None of the 8 later cycles on the archive passes the filter.

### Root cause (ARIA-MEDIUM-421)

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
  nothing. Each finding-bound red whose experiment resolves is answered exactly once, and the
  answer is final for that run. A new reproduction re-supports the belief. A run whose experiment
  is missing or has no `finding_ref` is passed over each night with no row.
- The repo-evidence policy is asked before the write. A refusal (scope files gone from HEAD) is
  recorded once as an uncertainty, so a backlog reader cannot fail the phase every night. The
  `except GovernanceError: return 0` around the observations read is gone. It never caught
  `LedgerIntegrityError` (a `RuntimeError`), so the only change is that a refused surface
  declaration fails the phase instead of reading as "nothing reproduced".
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

### Production evidence (ARIA-MEDIUM-421)

`record_experiment_reproduction_beliefs` was run for `cyc-20261010T080114Z` on a copy of the
archive (workspace = this checkout, `ARIA_REPO_STATE_ROOT` = the archive's `findings/`). It wrote
`finding-reproduced-f-020`:

- `supported` / `verified`, confidence 0.755;
- evidence `apps/alert-engine/src/rules-engine/safe-regex.util.ts`;
- `source_validation_run_id` `vrun-34f42790552f93ae`.

A second night wrote 0. No uncertainty was needed.

### Not done here (ARIA-MEDIUM-421)

- An observation whose experiment row is missing, or whose experiment has no `finding_ref`, is
  not a finding reproduction. It is passed over each night with no row written, as before.
- If an operator has withdrawn the belief, `_record_belief` returns the withdrawn row unchanged.
  That run is then re-read each night and counted in `beliefs_written`, a miscount that predates
  this change. There are 0 such beliefs on the archive.
- The plan's #1906 check (does it appear in change_outcome/reflection on the first cycle after
  PR-7) can only be made on a live night. It stays with `main`.

## ARIA-MEDIUM-428 — the next-cycle queue held 10 pressures in its 32 slots (fix, wave 2)

### Symptom (ARIA-MEDIUM-428)

On a copy of the archive's `queues/` and `governance.jsonl` (f5c5c86a1), the parent code
(0b88b2ccb) reads:

- `read_pending`: 32 items, `DEFAULT_QUEUE_DEPTH`, holding 10 distinct pressures;
- `append_pending` of a new pressure: `state: blocked`, `queue_depth_exceeded`,
  `pending_count: 32`.

The archive's governance already has 3 `next_cycle_queue_overflow_blocked` rows, all for
`pressure:runtime-signal:unknown` (10-08 16:41Z, 10-08 19:10Z, 10-09 09:19Z).

### Evidence (ARIA-MEDIUM-428)

- 8 items for `pressure:migration-surface-repeat:repetition`, 6 for
  `pressure:shadow-raw-delta:doc-staleness-adapter`, 6 for `pressure:own-pr-ci:pr-1335`, 5 for
  `mission:m-94d4bea861b82506`, 2 for `pressure:repo-pr-health:repo-pr-1022`, and 1 for each of
  the other five.
- 27 of the 32 items have the history pending → consumed → pending. The second pending row is
  a re-offer (`reoffered_reason: anchor_stale:AIR-aria-autonomy-planner-…`): 33 such rows,
  2026-10-07 23:09Z .. 10-10 03:14Z, 27 of them on 10-08 at 12:30Z and 15:40Z.
- `next_cycle_queue.py:320-363` (parent): `reoffer_item` checks the item's own rows and the row
  count. It never checks whether the item's pressure is already pending.
- `next_cycle_queue.py:189-193` (parent): the C10 dedupe returns the standing row, but only
  ahead of a NEW append. It never folds the duplicates already in the ledger, and the depth cap
  counts rows.
- The drain does not empty the queue. Governance has 12 `request_admission_throttled` rows
  for `next_cycle_queue.projection` (`backlog_at_drain_budget`), one per cycle:
  - first, `cyc-20261007T225133Z`: backlog 380, budget 32;
  - last, `cyc-20261010T080114Z`: backlog 180, budget 86.3.

  An item the drain cannot mint stays pending, so the queue is the only holder of that work.

### Root cause (ARIA-MEDIUM-428)

`pressure_id` is the queue's idempotency key, but nothing folded the queue by it. Two writers
could leave several pending items for one pressure: the pre-C10 appends, and the HIGH-360
re-offer, which brought September items back beside items of the same pressure. Every reader
counted rows. So one pressure took up to 8 depth slots, and a pressure new to a cycle (such as
the one a failed night's reflection plans, ARIA-HIGH-420) was refused.

### Fix (tier 1: the queue cannot hold two live items of one pressure)

- `next_cycle_queue.fold_queue` is the queue's one reading.
  - Per pressure, the pending item enqueued last is live. It carries the freshest pressure
    snapshot, which the drain reads through its `source_cycle_id`.
  - Every other pending item of that pressure is `superseded` by it
    (`reason: pressure_already_pending`, `superseded_by`).
  - The live item is `expired` (`reason: queue_item_aged_out`) when its latest offer is older
    than the request-anchor window, or its stamp cannot be read. An offer is the enqueue or a
    re-offer; a deferral row does not count.
- The window is the operator's `agent_request_anchor.max_age_seconds`
  (`agent_invocations._anchor_max_age_seconds`, also read by `request_drain_capacity`), 7 days
  live. A queue item is the agent request before its mint, so it ages by the same knob. Past that
  window, its snapshot is older than any request ARIA would still run. A pressure that still
  holds is queued again by the next reflection, with that night's snapshot. No work is lost.
- `read_pending` returns the live items. It is a pure read, so a duplicate is invisible even
  before anything is written.
- `append_pending`, `mark_consumed` and `reoffer_item` append the fold's verdicts that the
  ledger does not hold yet. They do this inside their own transaction, before their own row.
  Each verdict is therefore written once, and consuming a live item cannot bring back a sibling
  it superseded. No row is rewritten.
- The depth cap in `append_pending` and the full check in `reoffer_item` count live pressures.
- `reoffer_item` on an item whose pressure already has a live item returns
  `REOFFER_ALREADY_PENDING` and writes nothing. The anchor-stale disposition already records
  that outcome as re-offered (`queue_item_already_pending`), so no operator item is opened.

### Production evidence (copy of `queues/` + `governance.jsonl` only)

|                                | parent 0b88b2ccb                  | this fix                      |
| ------------------------------ | --------------------------------- | ----------------------------- |
| `read_pending`                 | 32 items, 10 pressures            | 10 items, 10 pressures        |
| `append_pending(new pressure)` | `blocked`, `queue_depth_exceeded` | `pending`                     |
| rows appended                  | 1 (`blocked`)                     | 22 `superseded` + 1 `pending` |

More results from the same run:

- The old ledger bytes are an exact prefix of the new ledger.
- `read_pending` wrote nothing.
- Re-enqueueing a live pressure returned the standing item and appended 0 rows.
- The window read 604800 s, the live policy's 7 days.
- No live item has aged out yet: the oldest live offer is 2026-10-07 17:29Z.

### Tests

`tests/test_next_cycle_queue_fold.py`, 12 tests. All are red on the parent; the import of the
new names was stubbed to run them there.

- The production shape: 12 rows of 3 pressures. A new pressure is admitted under depth 4, and
  the fifth is blocked at a `pending_count` of 4.
- The verdicts are written once, and the old bytes are a prefix of the new ledger.
- A reader sees no duplicate before any writer has run.
- Consuming the live item does not bring a sibling back.
- The freshest snapshot is kept over an older re-offered item.
- A re-offer beside a live sibling writes nothing.
- The full check counts pressures.
- An item not offered within the window expires.
- A re-offer is a new offer.
- An undateable offer buys no slot.
- The real anchor-stale sweep records `queue_item_already_pending` as re-offered.
- The real orchestrator runs two fail-closed nights with the clock moved past the window. The
  second night's reflection queues the pressure again with its own cycle id, and the first item
  is recorded `expired`.

The existing suites stay green: `test_next_cycle_queue`, `test_anchor_stale_disposition`,
`test_anchor_stale_migration`, `test_failed_cycle_reflection` and
`test_state_manifest_transaction`.

### Not done here (ARIA-MEDIUM-428)

- **Throughput.** This fix ends the saturation: the cap now counts work, and a new pressure is
  admitted. It does not change how fast the queue drains. The drain is still refused by request
  admission while the agent-request backlog is over the drain budget: 12 cycles in a row from
  10-07 to 10-10, with the backlog falling from 380 to 180 and the budget rising from 32 to 86.3.
  Ten live pressures can still wait for days. That
  backlog is the executor's capacity question (ARIA-HIGH-425 and the PR-8 diagnosis), not the
  queue's.
- **The 22 superseded items' dead requests.** These were already disposed by the anchor-stale
  sweep on 10-08 (re-offered). Nothing re-mints them: their pressures are live under the kept
  items.

### Review of 314c6a18e (zai)

- **Confirmed, fixed in the next commit.** The claim "every queue writer settles" was wrong in
  two ways.
  - `defer_projection` did not settle.
  - The consumers recorded `expired`, a verdict that depends on the clock. A drain pass reads
    first and writes one row per item afterwards. If the window closed in between, the pass
    could record an item `expired` and then `consumed`. A deferral row made the item pending
    again, so its expiry was written a second time. The repro, on 314c6a18e, gives the ledger
    tail: X expired, Y expired, Y consumed, X pending, X expired, X consumed.

  Now only `append_pending`, the writer that needs the slot back, records `expired`.
  `mark_consumed` and `reoffer_item` record only `superseded`, which depends on the ledger's
  order alone. `defer_projection` records nothing, because it does not change which item holds a
  pressure. The test `test_a_drain_pass_across_the_window_never_ages_what_it_acts_on` is red on
  314c6a18e.

- **Kept by design.** Aging runs from the kept item's own offer, not from a superseded sibling's
  fresher re-offer. That affects 5 of the 10 pressures on the archive, by 3 to 22 h. A re-offer
  says that the request for the sibling's older snapshot died. It does not make the kept
  snapshot fresher. A pressure that still holds is re-enqueued in the same `append_pending` call
  that records the expiry. zai's forecast on the archive: at 10-15 11:00Z, 5 live and 5 expired;
  at 10-16 00:00Z, 1 live and 9 expired. Each expired pressure that reflection still plans comes
  back as a fresh item.
- **Not done.** `anchor_stale_effects.reoffer_queue_item` records the re-offered item's id with
  `queue_item_already_pending`, not the live sibling that carries the work. This is a wording
  gap in a file outside this finding.

### Review of a1b060050 (zai)

- **Confirmed regression, fixed in the next commit.** `fold_queue` chose a pressure's item among
  ALL its pending items, and only aged the chosen one afterwards. With `reoffer_item` no longer
  recording expiry, the following happened:
  1. A was consumed.
  2. B was enqueued for the same pressure an hour later and was never drained.
  3. Past the window, the anchor-stale disposition re-offered A.
  4. The next fold kept B, the newer enqueue, and superseded A. Then B aged out.

  Nothing was live, yet the disposition recorded `queue_item_reoffered`. Now an aged item, whose
  latest offer falls outside the window or cannot be read, is `expired` and never holds its
  pressure. The live item is chosen among the fresh items only. This is a property of the fold,
  not of any one writer. `expired` is still recorded only by the enqueue. The test
  `test_an_aged_sibling_never_supersedes_a_reoffered_item` is red on a1b060050 and green here.
  The production proof is unchanged: 10 live, 22 superseded, and a new pressure admitted.

### Review of b55765234 (zai)

- **Confirmed (LOW: it needs legacy data and a window crossing during one drain pass), fixed in
  the next commit.** The fold's choice of live item now depends on the clock. The failing
  sequence:
  1. The drain read X as live.
  2. X aged before its own `consumed` row.
  3. That row's settle no longer saw X as the holder, so it wrote no verdict for X's fresh legacy
     sibling Y.
  4. Y became live and was projected a second time.

  The bound queue has the precondition: 22 unwritten `superseded` verdicts until the first settle.
  Now the consumption names the holder. `mark_consumed` writes `superseded`
  (`superseded_by` = the consumed item, reason `pressure_answered_by_consumed_item`) for every
  other pending item of the consumed item's pressure, whatever the clock. The test
  `test_a_consumed_item_answers_its_siblings_whatever_the_clock` is red on b55765234.
