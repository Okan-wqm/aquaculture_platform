# One command's deadline outlived it, and every later cycle in the process died before starting

**Date:** 2026-09-04 · **Agent:** claude · **Cycle:** 2026-09-04 pre-push forensics
**Finding:** ARIA-HIGH-064 — closed by this branch; this document is its evidence.

## Symptom

Two consecutive full local runs of the kernel suite (the pre-push gate, 258
modules, ~2 hours in ONE interpreter) failed with an unstable set of
failures — 27 the first time, 17 the second — always drawn from the same four
modules:

| module                                   | run 1 | run 2 |
| ---------------------------------------- | ----- | ----- |
| `test_enterprise_cycle`                  | 14    | 5     |
| `test_executor_drain_mode`               | 7     | 7     |
| `test_human_required_adjudication_sweep` | 3     | 3     |
| `test_observe_burn_in`                   | 2     | 2     |

Every one of them passes in isolation: those same modules plus the branch's own
new tests ran green in 41 minutes (69 passed). The same instability had already
reddened CI twice on `aria-kernel` (runs 33663053914 and 33688751606) and then
passed on a third attempt, which is why it read as flake.

## Reproduction

The burn-in assertion carries the report's own reasons since this branch, and it
named the mechanism outright: all 30 observe cycles died **inside one second
each** —

```text
"valid_cycles": 0,
"invalid_cycles": { "burnin-observe-…-001": [
  "cycle_not_completed", "discovery_not_complete", "memory_evidence_missing",
  "pressure_evaluation_missing", "triage_or_noop_proof_missing" ] , … ×30 }
```

and the drain, in the same run, reported

```text
drain_done attempted=0 succeeded=0 failed=0 stop=job_deadline_reached
```

Both are the signature of a deadline already in the past: `cycle.py`
`_run_phase_with_deadline` raises `PhaseDeadlineExceeded("no wall-clock
remaining before phase start")` before invoking the phase at all.

## Root cause

`ARIA_JOB_DEADLINE_EPOCH` is read in five places across two processes
(`cycle.py:_job_deadline_reached`/`_remaining_wallclock_seconds`,
`tools/aria-poc/claude_runtime.py`, `ci_executor_drain.py`, `ci_executor.py`,
and `agent_env.py` passes it through to an agent). It is an environment
variable, correctly, because the readers are in **child processes** — a
parameter cannot cross a fork.

The autonomy CLI handler wrote it with **no restore**:

```python
os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(_cap)   # cli.py, pre-fix
```

That is the only unscoped write of the variable in the kernel; every test that
sets it restores it in `tearDown` (`test_night_closes_at_deadline.py:24-31`,
`test_phase_deadline.py:32-34`). In production the CLI is one-shot, so the leak
is invisible. In the test suite, `test_cli_autonomy_subcommand` invokes
`cli_main(['autonomy', …])` six times; the first invocation pinned a deadline
over the remaining ~250 modules. Once wall-clock passed that epoch, every later
cycle, drain and burn-in was out of runway before it began — and _which_ tests
died depended on how far the run had got, which is exactly why the failing set
moved between runs and why re-running "fixed" it.

The defect was introduced by `ef4238fec` (merged in #1397), the in-phase
deadline interrupt for ARIA-HIGH-034 — a fix for one class of hang that opened
another.

## Fix

- `cycle.py` gains `JOB_DEADLINE_EPOCH_ENV` and `job_deadline_epoch(seconds)`, a
  context manager that binds the epoch and restores the inherited value (or
  removes it) on exit, including on exception. Narrowing is preserved: an outer
  cap is only ever tightened. `None`/`0` binds nothing. A malformed inherited
  epoch is ignored exactly as the readers ignore it.
- `autonomy_orchestrator.run_autonomy_orchestrator` carries
  `@_bound_job_deadline`, so the scope belongs to the function that already
  receives `cycle_deadline_seconds` — every caller gets it, not just the CLI.
- `cli.py` no longer touches the environment.

## Regression tests

`aria-kernel/tests/test_job_deadline_scope.py` — release on success and on
exception; an inherited cap restored, not erased; narrowing never widening;
`None`/`0` binding nothing; a malformed inherited epoch tolerated; a finished
run not poisoning the next (`_remaining_wallclock_seconds() == inf` afterwards);
an expired binding still interrupting _inside_ its own run; the orchestrator
actually decorated; and an AST scan asserting that `job_deadline_epoch` is the
only writer of the variable in the kernel.

The AST scan's first draft matched only string literals and therefore could not
see `os.environ[JOB_DEADLINE_EPOCH_ENV] = …` — the very spelling the fix uses.
It now matches the literal, the module constant and the attribute form; a
detector that cannot see the idiom it guards is not a gate.

## Proof

The poisoning module and its four victims, run together in one interpreter on
this branch:

```text
python3 -m unittest tests.test_cli_autonomy_subcommand tests.test_executor_drain_mode \
  tests.test_human_required_adjudication_sweep tests.test_observe_burn_in tests.test_enterprise_cycle
…
drain_done attempted=2 succeeded=2 failed=0 stop=queue_empty
Ran 71 tests in 1810.217s
OK
```

`stop=queue_empty` where the failing runs had `stop=job_deadline_reached`.

## Not changed here

The four modules also show genuine load sensitivity (a fixture tool's 30s budget
under load average 20-70, itself the subject of ORPHAN-MEDIUM-738). That is a
separate axis: it makes the suite slow and occasionally flaky, whereas this
finding made it deterministically wrong after a fixed elapsed time.

## Addendum 2026-09-11 — re-registered, and the budget caps join it

The fix above (`e927eac3f`, branch `fix/aria-job-deadline-scope`) never reached
`main`: it had no PR, and its finding id `ARIA-HIGH-038` lived only in that
worktree's registry. On 2026-09-11 the Codex-supervised publication push of
`8ec2536b` ran the full pre-push kernel suite into exactly this leak — five of
its failures are the burn-in and adjudication-sweep victims described above —
and the Codex repair wrapped `test_cli_autonomy_subcommand` in
`patch.dict(os.environ)`. That hides a production defect from the suite that
exists to catch it; it is not carried. The fix is cherry-picked onto current
`main` under a fresh id, **ARIA-HIGH-064**, with the same review file.

The same rule covered a second pair the first fix left in place. The autonomy
CLI also exported `MAX_BUDGET_USD_PER_RUN` and `MAX_BUDGET_USD_PER_CYCLE` into
`os.environ`, and `run_autonomy_orchestrator` re-exported the per-cycle cap —
"so child ci_executor subprocesses read it" (Plan ARIA-V8 §4 Phase 8.0). No
child reads either any more: ORPHAN-HIGH-472 retired the dollar gate because a
subscription session has no marginal per-run charge to cap, and
`reserve_cycle_budget`, the only in-kernel reader with an environment
fallback, has no production caller. What the export still did was leak across
the interpreter, which the services reviewer of the publication run observed
directly ("both MAX_BUDGET variables were absent before the fixture, present
after native CLI invocation"). The three writes are removed; the caps travel
as parameters and are recorded on the `autonomy_orchestrator_started` event
as telemetry, never as a gate. The AST invariant is now a table: the deadline
names its one restoring writer, each budget cap names nobody, and a
self-check proves the scan sees both the subscript and `update({...})`
spellings on a stub.

Proof: `tests.test_job_deadline_scope` (13) and
`tests.test_cli_autonomy_subcommand` (10) OK on current `main`; a probe that
runs the CLI autonomy module in-process and then reads the three variables
finds all of them absent.
