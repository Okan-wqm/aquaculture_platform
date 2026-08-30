# ARIA Wave 1 — counted is not consecutive

Date: 2026-08-03
Branch: `claude/aria-w1-ladder-freshness`
Scope: `aria-kernel/aria_kernel/autonomy_unlock.py::verdict_from_rows`
Closes: ORPHAN-HIGH-530

## The gap, and why the obvious fix is the wrong one

ORPHAN-HIGH-530 records that the scheduled-workflow watchdog's verdict
has no consumer inside ARIA. Issue #1005 reported ARIA's own nightly loop
as not-running, **hourly, for seventeen days**, while the ladder, the
merge authority and the program plan all continued as if evidence were
accumulating.

The obvious reading is "gate cycle recording on lane liveness". That
would be **vacuous**: if the lane is dead, no cycle runs, so
`record_clean_cycle` is never called and the gate never fires. It would
be a check that can only pass.

The real hazard is one level up. `verdict_from_rows` has **no time
dimension at all** — it counts acceptance events and compares the counts
against thresholds. So thirty successes spanning a seventeen-day hole
satisfy a threshold of thirty exactly as well as thirty consecutive
nightly ones do. The ladder's premise is _"N **consecutive** clean cycles
demonstrate stability"_, and counting cannot see a hole. When the lane
came back, the accumulated evidence would have gone on unlocking as if
operation had been continuous.

## Where the check lives, and why there

In `verdict_from_rows` — the ONE function the real ledger and the mock
ledger both go through. `autonomy_ladder` was deliberately built so the
two paths "share one rule and one policy, but two ledgers"; putting the
continuity requirement in that shared rule means neither path can be
written without it. That is the same argument as `publish_state`'s
ancestry proof: a check at the callsite is a check that can be omitted at
the next callsite.

Two halves, because an outage has two shapes:

- **a gap between events** — the lane stopped and restarted;
- **staleness at the open end** — the lane stopped and has not come back.
  Thirty perfect cycles that all ended a month ago describe a system that
  _was_ stable, which is not the claim an unlock rests on.

`MAX_ACCEPTANCE_GAP_HOURS = 72`. The nightly lane runs once a day; three
days of slack absorbs a delayed schedule (this repository's cron
routinely slips ~2.5 hours) or a single skipped night, without accepting
a hole big enough to mean the lane stopped.

## Three decisions worth naming

**Continuity is measured over SUCCESS rows only.** A `critical_violation`
row is not part of the "consecutive clean cycles" claim, so its timestamp
must not be able to bridge a gap between the successes the thresholds
count.

**An undateable row is REFUSED, not skipped.** Dropping a row with no
parseable `recorded_at` would let a malformed or hand-written entry
bridge a gap the timestamps would otherwise expose — the chain would be
checked against a version of itself with the inconvenient parts removed.

**An empty ledger produces no continuity reason.** There is nothing to be
discontinuous about, and the threshold refusal is the honest one. A
newborn ARIA must fail for the reason it actually fails.

## This is NOT a second watchdog

`scheduled-workflow-watchdog.yml` exists, runs hourly, and did its job
throughout the outage — issue #1005 is its output. Detection was never
the gap. Building a second detector would have been the copy-drift
disease this codebase has been bitten by repeatedly
(ORPHAN-CRITICAL-513).

The missing half was a **consumer**, and the acceptance rows carry their
own timestamps, so the question is answerable from ARIA's own ledger with
no GitHub call and nothing to keep in sync.

## Verification

`aria-kernel/tests/test_autonomy_unlock_continuity.py` — 7 tests, written
before the fix. The central one reproduces the exact shape of the
2026-07-17 outage: thirty rows with a seventeen-day hole, and it asserts
that `counts["observe_successes"] == 30` **while** the verdict refuses —
the count is satisfied, and only the gap objects.

Mutation-checked, three ways: removing the wiring fails 4 tests; skipping
undateable rows instead of refusing fails 1; removing the staleness half
fails 1. (The first mutation attempt silently failed to apply — the
"pass" it produced was meaningless, and it was redone against the real
text.)

Kernel suite 3089 green.

Owner: okan
