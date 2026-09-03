# The deadline that was meant to make the night publishable made it unpublishable

**Date:** 2026-09-03 · **Agent:** claude · **Cycle:** first producer cycle after #1397
**Finding:** ARIA-HIGH-037 — closed by this branch; this document is its evidence.

## Reproduction (live, run 33714052828)

The first `aria-auto-cycle` dispatched after #1397 merged (04:10 UTC) ran
its `Run the nightly cycle` step under heavy CPU contention (two
interactive test suites on the shared host; runner cgroup
`cpu.pressure some=53%`). Thirty minutes in, the in-phase deadline alarm
fired, as designed since ef4238fec:

```text
"code": "cycle_lifecycle_unreadable",
"cycle_id": "cyc-20260903T051221Z-auto",
"detail": "cycle raised before producing a lifecycle snapshot: PhaseDeadlineExceeded"
```

The cycle ledger, taken from the quarantine artifact
(`quarantine-evidence-33714052828`, `tools/cycles.jsonl`):

```text
cyc-20260903T051221Z-auto  started  2026-09-03T05:12:32+00:00
```

— and no terminal row. `integrity verify` therefore refused the whole
state:

```text
"cycle_lifecycle": {"valid": false, "incomplete_cycles": [{"cycle_id":
"cyc-20260903T051221Z-auto", "reason": "cycle has started event without
terminal event"}]}
```

The lane quarantined 66 MB of evidence and published nothing. Every
earlier failed cycle in the same ledger (2026-08-21, 2026-08-22) carries
its `failed` row: they failed through a handled phase, not through an
escaping exception.

## Root cause

`run_enterprise_cycle` owns the `cycles.jsonl` lifecycle and appends a
terminal row on every path it knows about — `ARIA_STOP`, continuity
abort, pre-phase abort, phase failure, completion. An exception that
escapes the function reaches none of them. Two paths escape by design:

- a `propagate` phase (discovery, the tool loop) has no handler — "if
  discovery cannot run there is no cycle to report on";
- `PhaseDeadlineExceeded` raised by the SIGALRM handler inside such a
  phase propagates with it (handled phases record `interrupted`; propagate
  phases cannot).

Both are correct about the _cycle result_; both were wrong about the
_ledger_. A started row with no terminal is not "no cycle to report on" —
it is an unverifiable state that blocks the publish of everything else
the night produced.

## Fix

`_sealed_cycle_ledger` wraps `run_enterprise_cycle`. On the way out of
any `Exception`, `_seal_open_cycle_after_raise` reads the cycle's rows and,
only if the last one is `started`, appends a `cycle_raised_before_seal`
governance row (exception type + message) and a `failed` terminal row,
refreshes the tools index, and re-raises. The guarantee is derived from the
ledger, not from control flow: a raise before the started row leaves no
orphan terminal; a cycle already sealed by the normal path is untouched;
a seal that itself fails is attached to the original exception as a note
and never masks it. The orchestrator still sees the failure and exits
non-zero — what changes is that the state it leaves behind verifies and
publishes.

## Regression tests

`aria-kernel/tests/test_cycle_seal_on_raise.py`: the deadline escaping a
propagate stage seals the cycle (`started, failed`; lifecycle valid;
`verify_integrity` ok; governance row present); any exception after the
started row seals; a raise before the started row leaves nothing; the seal
is idempotent against an already-sealed cycle.

## Related, not changed here

The cycle hit its 30-minute deadline because the runner was CPU-starved by
interactive sessions; that share is fixed by the habitat CPU weights in
[PR 1404](https://github.com/Okan-wqm/aquaculture_platform/pull/1404)
(ARIA-HIGH-034). This finding is about what happens when a deadline _does_
fire — it must always be safe to fire.
