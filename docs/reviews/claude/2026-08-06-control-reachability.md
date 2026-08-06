# The controls nobody calls — 2026-08-06

## ORPHAN-HIGH-573 — 21% of the kernel's declared controls were dormant

### The class, not the instance

Four findings closed in this programme are one defect wearing four names:

| finding               | what it was                                         |
| --------------------- | --------------------------------------------------- |
| `ORPHAN-CRITICAL-498` | a perimeter with no production caller               |
| `ORPHAN-HIGH-569`     | a discovery list the repository outgrew             |
| `ORPHAN-MEDIUM-571`   | a repository map nothing refreshed and nothing read |
| `ORPHAN-MEDIUM-572`   | a request vocabulary nothing consults               |

Each is **a control that is correct, tested, exported — and called by nobody.**

Every one was found by a human reading code. No gate has ever fired on this
class, and a green suite is no evidence against it: the tests call the control
directly. That is precisely how a control stays green while governing nothing.

Fixing them one at a time was treating symptoms. The root cause is that
nothing asks whether a control is connected to anything.

### The measurement

Of **85** public module-level callables in `aria_kernel` whose names begin
with a control verb (`validate_`, `enforce_`, `assert_`, `require_`,
`verify_`, `guard_`, `refuse_`, `check_`), **18 were referenced by no
production module at all — 21%.**

The verb convention is a usable definition rather than an arbitrary one: it
selects these functions because their own authors named them as guarantees.

### The one that mattered most

`verify_no_secret_in_envelope`. Its own docstring:

> _Hard-fail check — scan agent response envelope before kernel persists.
> Stringifies the envelope, runs the same secret-scan as diff. Defense against
> agent stdout / stderr / validation_results embedding secrets._

It was exported in `__all__`, covered by tests, **absent from
`HARD_FAIL_CHECKS`, and called by nothing.** Its sibling
`verify_no_secret_in_diff` _is_ wired — so diffs were scanned and the envelope
carrying agent stdout, stderr and validation results was not. The leak path
its docstring names was the one left open.

It is now called in `submit_claim_result`, at the moment the docstring
specifies — before the kernel persists the response — where a hit joins the
existing `reasons` list and refuses the envelope. The exception message is
redacted by construction (pattern name and count, never the matched value), so
appending it cannot move a secret into the rejection row.

### The fix is the gate, not the seventeen

`tests/invariants/invariant-reachability.spec.ts` already solved this shape for
TypeScript specs, and it learned one lesson expensively: it validated the
**shape** of `expires_on` with a regex and never compared it to the clock, so
twenty-five waivers sailed a month past a shared deadline in silence. Checking
the syntax of a date instead of the date is checking the syntax of a thing
instead of the thing.

That mechanism is now applied to the kernel — deliberately reused rather than
reinvented, because two ways to ask one question is how two answers start to
diverge. A dormant control must be declared with an **owner, a reason, a
deadline and a finding ID**, and:

- a waiver past its deadline fails the suite;
- a waiver for a control that has since been wired fails the suite, so the
  manifest cannot rot in the other direction;
- a waiver naming a control that no longer exists fails the suite.

The 17 remaining waivers are **not deferral**. Each names why the control has
no caller _today_ — a lane not yet live (skill-genesis, autonomous fix
dispatch, real-mode eval), a duplicate entry point pending a deliberate
collapse (`assert_within_breaker`, `verify_branch_tip`, `require_tools_v2`),
or a decision owned by a specific PLAN wave — carries a deadline, and fails
the day it expires.

Three are worth naming as genuinely missing consumers rather than duplicates:
`verify_claim_disjointness` (judge fan-out scores claims with no independence
pass), `validate_generated_adapter` and the two adapter sandbox checks (the
skill-genesis lane validates nothing kernel-side).

### What counts as reachable, and the hole the gate found in itself

A control is reachable if a production module **uses** it: a call, a registry
tuple membership, a string in a dispatch table. Excluded are its own `def`
line, its module's `__all__` (exporting is not using — `ORPHAN-MEDIUM-572` was
in `__all__` and governed nothing), prose, and **imports**.

The import exclusion is not fastidiousness; the gate caught itself without it.
The mutation _"replace the one call to `verify_no_secret_in_envelope` with
`pass`, leave the import"_ left the suite **green** — the import counted as a
reference. A control imported and never invoked is exactly the defect being
hunted, so the gate would have certified it. Imports are now excluded by AST
line span and that mutation goes red.

That is the third time this session mutation checking has caught a control of
mine that was weaker than its own name, and the first time the thing it caught
was the anti-defect gate itself.

### Verification

New suite `aria-kernel/tests/test_control_reachability.py`, 7 tests.

| mutation                                           | result                         |
| -------------------------------------------------- | ------------------------------ |
| un-wire the envelope secret scan (keep the import) | 2 red _(after the import fix)_ |
| a waiver past its deadline                         | red                            |
| a waiver with no `finding_id`                      | red                            |
| drop a dormant control's waiver entirely           | red                            |
| leave a stale waiver for a control that is wired   | 2 red                          |

Counts: 85 controls, 18 dormant before, **17 declared + 1 wired** after.
