# ARIA review — 2026-09-09: the acceptance lane measured nothing

- Date: 2026-09-09
- Owner: `okan`
- Trigger: adversarial re-validation of an operator claim about ARIA's maturity
- Method: every claim executed against the repo, never read off a document

`tools/aria-acceptance/harness.py` is, by its own docstring, "the *truth layer*
of the acceptance lane — its pass/fail verdict is a deterministic assertion
against repo evidence, never an LLM opinion." It is the only instrument that
audits ARIA from outside ARIA.

Running it produced `OVERALL: REJECT`. Investigating why produced four defects
that share one shape: **a control that reports a verdict it did not earn.** One
reported success having measured nothing; two reported failure for reasons that
said nothing about ARIA; the fourth is the reason nobody noticed the first
three.

A fifth finding (`ARIA-HIGH-044`) is recorded here and NOT fixed by this
change — it needs a registry write-path change that deserves its own review.

## Method note — what "validated" means here

Claims in this document were produced by execution, not by reading. Two
hypotheses were tested and REJECTED, and are recorded so the negative results
are not re-derived later:

- *"The `agent-harness-security-adapter` has no implementation"* — false. It is
  implemented in Python at `tools/aria-poc/agent_harness_security_adapter.py`;
  the absent `.ts` sibling is a language choice, not a gap.
- *"`aria-tools/registry.json` is missing"* — false. It is gitignored
  (`.gitignore:249`) runtime state, absent from a fresh clone by design.

One prior claim by this reviewer was also withdrawn: the acceptance lane's
`aria-acceptance-gap-hunter` was credited with raising the 14 open ARIA
findings. It did not. All 14 carry `owner_agent: platform-autonomy` and
`raised_in_cycle: 2026-08-22-autonomy-closure-plan-audit` — a plan audit
registering the gaps of its own closure tasks.

## ARIA-CRITICAL-040 — the truth layer reported PASS on a sample of zero

**Problem.** `validate_drift_output` ended with `"passed": unverifiable == 0`.
When ARIA emits no above-threshold drift, `checked` is 0, so `unverifiable` is
trivially 0, so the check passes. The acceptance lane's own truth layer printed:

```
[PASS] drift_output_validation — checked=0 TP=0 FP=0 unverifiable=0
```

A green produced by an empty sample. This is the class the enterprise-grade
debt-plan contract exists to refuse, reproduced inside the instrument that
polices it.

**Why it stayed invisible.** One `passed` flag answered two different questions:
*did ARIA cite evidence that resolves* (integrity) and *did ARIA emit anything
to check* (sample size). Collapsed, the second question had no way to be heard.

Worse, the scan was narrower than the artifact. `poc.py` on this repo emits four
signals — two in `drifts_filtered_below_threshold`, two in
`frontend_dropdown_drifts` — and the check reads only `drifts_above_threshold`.
Three of the four were never examined at any point in the lane's life. (Of the
four, one is a real product defect: `LeavesPage.tsx:346` offers four of six
`LeaveRequestStatus` values, so `draft` and `withdrawn` leave requests cannot be
filtered for. The other three are true false-positives — two `equipment`
concept collisions comparing a status enum to a category enum, and a
`financescope` dropdown that correctly omits `HR_EXPENSE` because
`libs/event-contracts/src/finance-events.ts:14` assigns that scope to
hr-service.)

**Fix.** The two questions are now separate. `verdict` carries three states —
`pass`, `fail`, `inconclusive` — and an empty sample yields `inconclusive`,
which does not set `passed` and therefore cannot produce exit 0. `fp_rate` is
`None` rather than `0.0` when nothing was judged: no sample means no rate, not
a rate of zero. The integrity sweep now runs over every emitted signal
regardless of Jaccard score, because a fabricated ref is a fabricated ref at any
score; the TP/FP split stays scoped to the above-threshold set, which is the
only set ARIA asserts as a finding. The report prints `INCONC` as its own mark,
and prints `PRECISION UNMEASURED` when integrity was verified but no finding was
asserted — a bare `PASS` beside `checked=0` invites the exact misreading the
check exists to prevent.

**Regression test.** `ZeroSampleVerdictTests` pins all three states, including
that a sub-threshold signal alone counts as a sample and that an unresolvable
sub-threshold ref fails.

## ARIA-HIGH-041 — the harness could never accept, for a reason about itself

**Problem.** `run_cycle_acceptance` builds a fixture workspace holding
`src/app.ts`, `package.json` and `nx.json` — and no git repository. ARIA's
`experiment_night` phase anchors evidence to a HEAD SHA, found none, and failed;
the cycle terminated `failed`; the check requires `completed`. `npm run
aria:acceptance` therefore returned REJECT unconditionally, for a reason that
said nothing about ARIA's behaviour.

**Test that proves it.** Same fixture, one variable:

```
git_repo=False -> status='failed'    failed_phases=[{"phase":"experiment_night",
                                       "error":"experiment_night_head_sha_unavailable"}]
git_repo=True  -> status='completed' failed_phases=[]
```

**Fix.** `_git_init_fixture` makes the workspace a real repository. The two
rejected alternatives are worth recording: relaxing the assertion to accept a
failed cycle would have green-pinned a broken oracle (the defect
`ARIA-AUDIT-025` already named), and making `experiment_night` skip when git is
absent would weaken a real contract to suit a fake workspace. ARIA observes
repositories; a bare directory is not a smaller habitat, it is one ARIA has no
contract to run in. The fixture was the wrong artifact.

**Second defect, same finding.** The check reported `status=failed` and nothing
else — diagnosing it required a manual descent into the kernel. `failed_phases`
is now carried into the result and printed, so an operator can separate an ARIA
defect from an environment fault without reading kernel source.

## ARIA-HIGH-042 — the self-test suite could not be imported, so none of it ran

**Problem.** `tools/aria-acceptance/test_harness.py` raised at import:

```
File "tools/aria-acceptance/test_harness.py", line 71, in <module>
    self.assertEqual(result["cycle_status"], "completed")
NameError: name 'self' is not defined
```

Two assertions added for `ARIA-AUDIT-025` sat at column 0 — outside their method
and outside their class — so they executed at module scope, where `self` does
not exist. A second defect compounded it: `if __name__ == "__main__":
unittest.main()` sat mid-file, above `ScorecardPersistenceTests`, so that class
would not have been collected even had the module imported.

Zero of nine tests could run. The file landed in this state on 2026-09-06 (PR
#1458) and nothing reported it for three days. `CycleAcceptanceTests` is
precisely the test that would have caught `ARIA-HIGH-041` on the day it was
written.

The file's own docstring, in the class the misplaced `unittest.main()` hid,
reads: *"A measurement nobody can read later is a claim, not a measurement."*

**Fix.** Assertions restored to their method, `unittest.main()` moved to the end
of the file. Collection goes from 0 to 12 tests (9 restored, 3 added), all
passing — including `test_isolated_cycle_closes_and_keeps_ledger_valid`, which
had never once executed.

## ARIA-MEDIUM-043 — the lane was a file, not a gate

**Problem.** `npm run aria:acceptance` was invoked by no workflow. It appeared
only in the operator-manual `closure-run --profile gates-all` step list
(`tools/quality/quality.mjs`), which no CI job drives either.

`tests/invariants/test-target-ci-reachability.spec.ts` exists to catch exactly
this — but it collects root scripts with
`.filter(([name]) => name === 'test' || name.startsWith('test:'))`, and
`aria:acceptance` does not match that prefix. A test entrypoint named outside
the `test:` namespace is invisible to the gate that enforces test entrypoints.
Separately, `scripts/ci/aria-suite-run.sh` runs `unittest discover aria-kernel`,
rooted at `aria-kernel/` — and the acceptance lane lives outside the kernel by
design (the thing that audits ARIA cannot be part of ARIA), so its suite was
never in discovery range.

**Fix.** `aria:acceptance` is renamed `test:aria-acceptance`, which puts it
inside the reachability gate's namespace, and a `test:aria-acceptance:unit`
script runs the self-test suite. `aria-kernel.yml` invokes both. Verified
against the invariant's own regex and corpus: both scripts resolve as
CI-reachable, and `UNREACHABLE_ROOT_SCRIPTS` is empty, so neither needs an
exemption.

**Residual, named.** The rename makes THIS lane reachable; it does not close the
hole that a `test:`-prefix scan cannot see a test entrypoint named anything
else. Widening that scan touches every root script and belongs to its own
change — tracked as `ARIA-MEDIUM-043-R1`, owner `okan`, deadline 2026-10-31.

## ARIA-HIGH-044 — three open CRITICALs that no governance timer can reach (OPEN)

**Not fixed by this change.** Recorded with owner and deadline as the sanctioned
shape for debt.

**Problem.** Of 30 non-RESOLVED CRITICAL findings, 27 carry both `owner_user` and
`deadline`. The three that carry neither are ARIA's own: `ARIA-CRITICAL-007`,
`-009`, `-015`.

That combination is unreachable by design-accident. `planSweep`
(`tools/gates/finding-registry.ts:1286`) exempts CRITICAL findings from
auto-staleness — correctly: silence is not resolution. The other exit,
`deadline` in the past → `BLOCKED` (line 1260), never fires without a deadline.
A CRITICAL with `deadline: null` is therefore permanently invisible to the
sweep.

**Test that proves it.** The repo's own `planSweep`, run against the real
registry at `now = +1y`, `+10y`, `+50y`:

```
now=+50y : sweep acts on 11/14 OPEN ARIA; NEVER acted on 3:
    ARIA-CRITICAL-007  CRITICAL  deadline=null
    ARIA-CRITICAL-009  CRITICAL  deadline=null
    ARIA-CRITICAL-015  CRITICAL  deadline=null
```

**Root cause, and the fix that belongs in its own change.** `buildFinding`
(`finding-registry.ts:534`) defaults `deadline: stub.deadline ?? null`, so a
CRITICAL may be created without one. CLAUDE.md requires owner + deadline + ID
for tracked debt; the requirement lives in prose, and prose is what the three
findings skipped. The architectural fix is Tier 1 — the `add` path REFUSES a
CRITICAL stub with no deadline, making the gap unrepresentable rather than
remembered. That changes the registry write path and needs its own regression
tests, so it is not bundled into a harness repair.

- Owner: `okan`
- Deadline: 2026-10-15

**Note on the truth table.** An earlier reading of this finding claimed
`docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md`
held a task label in a deadline column. That was wrong: the column is
`First sprint`, and `Task 10` is a valid value for it. There is no
contradiction between the two stores — there is simply no deadline in either.

## What the lane reports now

```
[PASS] drift_output_validation — checked=0 TP=0 FP=0 unverifiable=0
       (+4 sub-threshold signals swept for evidence)
       — evidence integrity verified; PRECISION UNMEASURED (no above-threshold drift)
[PASS] cycle_acceptance — status=completed
[PASS] scenario_reactions — stale_belief_decays=ok, consensus_disagreement_escalates=ok,
       runtime_signal_becomes_pressure=ok
=== OVERALL: ACCEPT ===
```

The honest reading of that ACCEPT: ARIA's cycle completes, its three scripted
reactions fire, and every ref it cited resolves. Its **precision remains
unmeasured**, because on this repo it asserts no finding above the 0.3 Jaccard
threshold. That is now stated on the line rather than hidden behind a green
mark, and it is the number the next work should move.

Baseline for that work, from this run: four emitted signals, one real
(`LeavesPage.tsx:346`), three false positives. Too small a sample to conclude
from, and the first honest figure the lane has produced.
