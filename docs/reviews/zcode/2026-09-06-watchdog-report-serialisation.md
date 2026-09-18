# Watchdog report serialisation — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Recovered from `feat/new-aria-standalone-copy`, whose `CORE-DELTAS.md` lists it as delta G-7. That
branch adds a 1570-file standalone product tree under `new-aria/` and was not merged; this defect is
one of the three deltas it holds that are genuinely main's.

## ARIA-HIGH-039 — the sweep's report dies on json.dumps, after its work has landed

**Severity:** HIGH. **Owner:** aria-acceptance-gap-fixer. **State:** IN-PROGRESS.

**Evidence.** `aria-kernel/aria_kernel/aria_watchdog.py`, `run_watchdog_sweep`, computed
`latest_governance_ts` through `_parse_iso` — which returns a `datetime` — and returned that object
in its result dict. The dict's readers cannot take it:

- `aria_kernel/cli.py:488` prints the cycle result with `json.dumps(result, indent=2,
sort_keys=True)`, which raises `TypeError: Object of type datetime is not JSON serializable`;
- the daemon loop in the same module read the value straight back out as an instant, which is the
  only reason the type mismatch survived at all;
- `aria-kernel/tests/test_seed_mint_migration.py:107` already spells this field as the ISO string
  `"2026-08-17T00:00:00+00:00"`, so the kernel's own fixtures documented the intended contract that
  the producer did not honour.

Reproduced on main before the fix: one governance row and a pinned window return
`type(latest_governance_ts) == datetime`, and `json.dumps` on the result raises.

What makes this HIGH rather than cosmetic is the ORDER of the failure. The sweep emits its findings
and appends its governance ledger rows first; the serialisation happens last, when the cycle reports
what it did. So the process exits non-zero with no output while the side effects have already
landed — work done, unaccounted for, and an operator looking at a stack trace with an empty report.

**Rule violated.** A value that crosses a JSON boundary is made serialisable at the producer, not at
each reader. A report that can die after its side effects have committed is worse than one that
fails first.

**Fix.** `run_watchdog_sweep` emits `latest_governance_ts` as an ISO string (or `None`), matching the
contract the kernel's fixtures already assumed, and the daemon loop parses it back with the
`_parse_iso` that produced it. `aria-kernel/tests/test_watchdog_sweep_json_serializable.py` pins all
three cases — the value is a string, the whole report survives `json.dumps`, and an empty governance
log reports `None` and still serialises — with the window pinned so the fixture cannot age out.

**Closure criterion.** The new test fails on the pre-fix code (2 of 3 cases) and passes after; the
watchdog-adjacent kernel suites are green (42 tests, 7 subtests).
