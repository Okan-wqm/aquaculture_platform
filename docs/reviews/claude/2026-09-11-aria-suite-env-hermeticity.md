# The kernel suite inherited the caller's state roots; one fixed root made every fixture another's

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — publication-lane forensics
**Finding:** ARIA-HIGH-065 — closed by this branch; this document is its evidence.

## Symptom

The Codex-supervised publication push of `8ec2536b` ("make event-schema
regressions fail native cycles") ran the pre-push kernel suite and reported
**2,849 tests / 8 failures / 38 errors / 16 skipped in 7,948 s**. Thirty-seven
of the errors had one shape:

```text
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

## The first full run — the detector caught the next leak

The pre-push gate on this branch ran the full affected selection: **3,128
tests, 1 failure** — every one of the original 46 gone, and the one failure
was this branch's own `test_this_suite_never_resolves_a_workspace_under_the_
home_tree`, green in isolation, red after 3,000 tests. Four fixtures
(`test_migrate_tools_v3`, `test_phase1_e2e_invariants`,
`test_phase2_fates_snapshot`, `test_phase3_discovery_mfe`) set
`ARIA_WORKSPACE_BASE` in `setUp` and **popped** it in `tearDown` — so from the
first of them onward the interpreter had no base at all and every later
fixture wrote under `~/.aria`. That is the mechanism behind the 4,927
directories, now attributed. Each of those fixtures scopes the whole
environment to the test (`patch.dict(os.environ)` + `addCleanup`), and a
new last-in-order module, `test_zzz_process_environment_left_clean`, asserts
at the end of the suite that the bootstrap's state survived: workspace base
still the suite-owned temp dir, no shared state root, tools dir still a
fixture store, no run-scoped deadline/budget variable. It cannot name a
culprit (unittest has no per-test hook without a custom runner) so its
message says how to bisect. Proof: all 32 environment-mutating modules run in
one interpreter followed by both detectors — 353 tests OK.

## Residual, tracked

An in-cycle validation that runs the kernel suite still inherits the
store-bound `ARIA_TOOLS_DIR` and `ARIA_WORKSPACE_BASE` (both keyed per
fixture, so no cross-fixture replay, but fixture state lands in the store's
tools and workspace trees). The owner of that boundary is `validation.py`'s
command environment, not the test package; it is raised as its own finding,
ARIA-MEDIUM-066, with the validation stage of the end-to-end chain as its
deadline.

## Addendum — the race fixtures' 5 s bound was a performance budget in disguise

The second pre-push run of this branch (3137 tests, 17,933 s, the host in
IO wait beside two live model runs) ended `FAILED (failures=3)`: the three
`*_rechecks_result_after_submit_wins_lock` fixtures in
`test_agent_submit_result_e2e`, each with `TimeoutError('submit did not
finish')`. The fixtures pause one lifecycle writer before it takes any lock
and let the main thread run the REAL `submit_claim_result`; the paused
writer waited 5 s for the submit to finish. No lock was held by the paused
thread, so nothing could deadlock — the real submit simply took longer
than 5 s on a busy host, and the guard against a wedged peer fired as if
it were a budget. `RACE_LIVENESS_SECONDS = 120` now names what the bound
is for; the same class of wait in the sibling `submit-before-release`
fixture uses it too. Not a hermeticity defect — the branch's own suite
run measured it, so it is closed here rather than carried.

## ARIA-HIGH-109 — liveness guards used as performance budgets across the lock, probes and executor

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-20
- **Evidence:** push #4 of this branch (33,754 s pre-push suite, 3 failures):
  `test_publish_contention` writers raised `with_exclusive_lock_timeout`
  at `file_lock`'s 5 s default while a replay legitimately held the
  state-group locks across capped git steps; `test_seed_evidence_concrete`
  graded a committed glob `worktree_candidate` because
  `_git_blob_matches` returned `False` on `TimeoutExpired`. The same class
  sat one seam further at every turn the five verification rounds looked:
  the executor killed its submit child at 120 s while the kernel bound was
  minutes, the acceptance harness billed a host stall to ARIA's FP rate,
  the lifecycle lock waited one git step's cap for a holder running five,
  the ledger bound was a typed "two steps" against a traced three-step
  recovery, and `human-required record` children ran at 30 s.
- **What is now true (five rounds, each independently re-verified):**
  `state_store_lifecycle_arcs.py` registers every heavy git step under the
  lifecycle lock (11 steps) and under a state transaction (3 arcs) and
  derives the bounds from the arcs — `STATE_LOCK_LIVENESS_SECONDS` = the
  pending-recovery arc (900 s), one deadline across the ordered locks;
  `STATE_STORE_LIFECYCLE_LIVENESS_SECONDS` = the publish arc (5400 s); a
  runtime guard refuses an unregistered or unpriced heavy step; the arcs
  are AST-walked (`test_state_lifecycle_arcs_derived`) and runtime-traced
  positionally (`test_state_lock_arcs_traced`). `evidence_probe.GitProbeSession`
  (30 s attempts ×3, backoff, one 300 s clock per decision, baseline
  resolved once) grades `verification_unavailable` — never resolvable,
  never `worktree_candidate`; every decision-side caller (memory, debt,
  finding, expert gate, the submit seam, `evidence_target_sha`, the anchor
  probe) runs one session; the submit response carries `rejection_codes`
  and the executor releases harness-class
  `evidence_verification_unavailable`; a pre-claim git gate refuses a
  workspace whose git cannot answer. The executor's children are priced
  from the kernel bounds (`child_worst_case_seconds` 6333 s; drain window
  7200 s; job reserve 9000 s; job 280 min; per-request worktree add/remove
  bounded; kernel-import fallback visible). Claim/reaper timestamps are
  read under the lock. `notify` senders run under one wall clock and the
  acceptance harness reports `host_unavailable` apart from `fp_rate`.
- **Residuals, tracked:** ARIA-MEDIUM-110 (notify dedup across channels),
  ARIA-MEDIUM-111 (direct transaction appends bypass the ENOSPC
  translation; the executor's model-refusal append is unpriced).
- **Proof:** the lane battery (61 modules, 878 tests / 277 subtests) + 14
  adjacent modules (142) + the acceptance harness (18 unit, `harness.py`
  OVERALL ACCEPT); every pinning test fails on `2591fcc79`. Verified by
  `wf_5229dba4-11e`, `wf_c02ed913-698`, `wf_6a5e9dd8-e28`,
  `wf_cf0825d5-602`, `wf_afce3d0e-768`, `wf_883d4922-940`.

## ARIA-MEDIUM-112 — the registry allocator could not run once the worktree sweep outgrew a spread call

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-09-20
- **Evidence:** registering ARIA-HIGH-109 on this branch: `add-explicit`
  failed closed with `Maximum call stack size exceeded` at
  `claimedIdsForDomain` — `claimed.push(...ids)` over 98 worktrees ×
  ~1,600 registry rows.
- **What is now true:** the sweep appends in a loop (`appendAll`) and
  `idsFromActiveRegistries` takes an injectable reader, so
  `finding-registry-allocation-scale.spec.ts` pins 100 registries × 2,000
  ids without touching disk; the spread variant fails it.
