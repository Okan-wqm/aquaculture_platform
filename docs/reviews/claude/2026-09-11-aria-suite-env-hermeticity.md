# The kernel suite inherited the caller's state roots, and a fixed one turned every fixture into every other fixture's history

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — publication-lane forensics
**Finding:** ARIA-HIGH-065 — closed by this branch; this document is its evidence.

## Symptom

The Codex-supervised publication push of `8ec2536b` ("make event-schema
regressions fail native cycles") ran the pre-push kernel suite and reported
**2,849 tests / 8 failures / 38 errors / 16 skipped in 7,948 s**. Thirty-seven
of the errors had one shape:

```
aria_kernel.tool_registry.GovernanceError: finding event
'finding:F-901:finding_reproduced:2026-08-16T03:00:00+00:00' references
'F-901' before its finding_emitted row
```

spread across `test_experiment_finding_bridge`, `test_experiment_night`,
`test_finding_promotion`, `test_rule_health`, `test_seed_mint_migration`,
`test_x2_experiment_author` and `test_human_required_adjudication_sweep`; three
`test_change_outcome.VerdictTests` failures and one `test_finding_promotion`
directory assertion belong to the same family. The same commit's code was
green in CI (`aria-kernel` on PR #1547, and on `main` itself).

## Mechanism

`workspace.repo_state_root(repo_root)` is the one seam that decides where
`aria-findings/` and `aria-debts/` live: the repo root, unless
`ARIA_REPO_STATE_ROOT` is set, in which case that ONE directory — for every
repository. That is the right contract for a runtime cycle, which serves one
repository and must keep finding identity across runners. It is never a valid
contract for the test suite, which builds hundreds of fixture repositories
in one interpreter: under a fixed root the `finding_reproduced` event that
`test_change_outcome`'s outcome fixture writes for `F-901` is still on disk
when `test_experiment_finding_bridge` emits its own findings, and
`finding.py:903` correctly refuses the malformed history.

The publication push set the root — together with `ARIA_TOOLS_DIR`,
`ARIA_WORKSPACE_BASE` and `ARIA_STATE_STORE_ROOT` — to gate directories under
`/tmp/codex-aria-spine-publication-20260911/` (`publication-push.json`,
`environment_overrides`), with the reasonable intent of keeping gate state out
of the checkout. Neither `scripts/ci/aria-suite-run.sh` nor the `aria-kernel`
workflow sets it, which is why CI never saw the family.

Reproduced on clean `main` (`53d3e82d`) with the ordered pair the Codex
diagnosis had isolated — `tests.test_change_outcome.VerdictTests.
test_no_gain_when_the_finding_reproduces_after_the_merge` then
`tests.test_experiment_finding_bridge.ExperimentFindingBridgeTests.
test_certainty_vocabulary_is_producer_backed`:

| environment                                     | result                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `ARIA_REPO_STATE_ROOT` unset (CI shape)         | `Ran 2 tests … OK`                                                              |
| `ARIA_REPO_STATE_ROOT=<fixed dir>` (push shape) | `GovernanceError … 'F-901' before its finding_emitted row`, `FAILED (errors=1)` |

The Codex diagnosis had run only the second row, on base and candidate, and
concluded (correctly) that the spine commit did not introduce it — then
repaired it by binding a fixture-local root in two fixtures
(`test_change_outcome.py`, `test_finding_promotion.py`). Two out of the
hundreds of fixtures that emit findings; the next fixed-root run would have
found the next pair.

The second half of the finding is the same class one level up.
`workspace_paths(repo_root)` falls back to `~/.aria/workspaces/<repo-hash>`
when `ARIA_WORKSPACE_BASE` is unset, and the suite never sets it: **4,927**
directories had accumulated under `/root/.aria/workspaces/` by 2026-09-11,
each one's `repo_identity.json` naming a `/tmp/tmp…` fixture as its
`repo_root`. `tests/__init__.py` had already closed exactly this hole for
`ARIA_TOOLS_DIR` (ORPHAN-MEDIUM-767) and nothing pinned that behaviour either.

The remaining five failures of the original run — two `test_observe_burn_in`,
two `AdjudicationSweepIsWired`, and their sibling error — are not this
finding: they are the wall-clock victims of the deadline leak that
ARIA-HIGH-064 closes in the same branch.

## Fix

`aria-kernel/tests/__init__.py`, the package bootstrap that already owns
suite isolation, now:

- **unbinds an inherited `ARIA_REPO_STATE_ROOT`** and writes one stderr line
  naming the value and the reason. Unbound rather than refused, on purpose:
  the `restore-aria-state` action exports the durable store's whole
  `store_environment` binding into the job, and an in-cycle self-validation
  that runs this suite (`self_improvement.DEFAULT_VALIDATION_COMMAND`)
  inherits it through `validation.py`'s `{**os.environ, …}`. Refusing would
  fail every kernel self-change; honouring it would write fixture findings
  INTO the durable store. Unset is the only configuration under which fixtures
  cannot see each other, and a fixture that needs the redirect binds it
  inside its own lifetime (`test_experiment_night` already does).
- **defaults `ARIA_WORKSPACE_BASE`** to a session temp directory when unset,
  the mirror of the `ARIA_TOOLS_DIR` rule. An explicit base is honoured.

`aria-kernel/tests/test_suite_env_hermeticity.py` pins all of it in fresh
interpreters (the bootstrap runs once per process, so asserting on the suite's
own process would only observe whatever the runner started with): inherited
root unbound and announced; absent root not announced; two fixture repos
resolve to two state roots; workspace base defaults off the home tree and an
explicit one is kept; the tools-dir contract (real mirror refused, temp
default), which had no test.

Codex's two fixture-local bindings are not carried: they were correct in
isolation and wrong as the owner, and with the bootstrap in place they guard
nothing. The `patch.dict(os.environ)` it added to
`test_cli_autonomy_subcommand` is not carried either — it would have hidden
the production leak ARIA-HIGH-064 closes from the very suite that is supposed
to catch it.

## Proof

- `tests.test_suite_env_hermeticity`: 8 tests OK.
- The exact ordered pair above, run under the push's fixed root on this
  branch: `tests: ARIA_REPO_STATE_ROOT=… was inherited and has been unbound …`,
  `Ran 2 tests … OK`, and the fixed directory was never created.
- Full-suite run and the pre-push gate: recorded in the PR.

## Residual, tracked

An in-cycle validation that runs the kernel suite still inherits the
store-bound `ARIA_TOOLS_DIR` and `ARIA_WORKSPACE_BASE` (both keyed per
fixture, so no cross-fixture replay, but fixture state lands in the store's
tools and workspace trees). The owner of that boundary is `validation.py`'s
command environment, not the test package; it is raised as its own finding,
ARIA-MEDIUM-066, with the validation stage of the end-to-end chain as its
deadline.
