# main GitHub Actions health (2026-10-04)

Context: six workflows had a red latest run on `main` on 2026-10-04 (aria-readiness-claim, Scheduled
Workflow Watchdog, Deploy Capacity Maintenance, ARIA External Watchdog, CI - Full, Database WAL
Archive Freshness). Each latest failed run was read with `gh run view <id> --log-failed`; this file
records the repository defects found among them. The red runs that are correct alarms on an
operational condition are not findings here and are not silenced.

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-348

Evidence (at `main@690470509`):

- Run 37221868753 (PR #1779, 17:47Z): `aria_kernel.tool_registry.GovernanceError:
dlp_diff_surface_incomplete: files touched by d38b25979f82 absent from the scanned diff:
['.github/workflows/aria-auto-cycle.yml', ...]`. 37 of the lane's 44 failures on 2026-10-04 end
  in this error (PRs #1335, #1435-#1444, #1731-#1781); the other 7 reach the branch-protection gate
  and are rejected there (a correct alarm, see the operator section of the hand-off report).
- `.github/workflows/aria-readiness-claim.yml:169-170` — the `diff` DLP surface was
  `gh api repos/.../compare/<base>...<head> --jq '.files[].patch // empty' > compare.patch || true`.
  The compare API's per-file `patch` field is the hunk body only: no `diff --git a/<path> b/<path>`
  header, and no field at all for a binary or oversized file. `|| true` turned an API failure into
  an empty file.
- `aria-kernel/aria_kernel/readiness_proofs.py:1259` — `produce_dlp_proof` derives the touched set
  with `git show --name-only <head_sha>` in the workspace; `:1271` — it requires each touched path to
  appear in the scanned diff text; `:1274` — otherwise it raises `dlp_diff_surface_incomplete`.
  A path therefore reached the scanned text only when the file's own content spelled it, so the
  lane could not produce a claim for an ordinary PR.

Fix: the kernel builds the surface (`aria_kernel/readiness_diff_surface.py`,
`readiness build-diff-surface`) with `git diff <base>...<head>` from the same object store the scope
check reads, so the scanned text and the touched set come from one source. Full object ids only;
an unresolvable commit fails closed before anything is written. The lane calls it and the `|| true`
is gone. Tests: `aria-kernel/tests/test_readiness_diff_surface.py`.

## INFRA-MEDIUM-203

Evidence (at `main@690470509`):

- Run 37221005747 (17:34Z): `##[error]9 scheduled workflow(s) are stale or failing`. Issue #1005
  lists `aria-merge-runner.yml | failure | 154.9 | 3`. That workflow has been `disabled_manually`
  since 2026-09-28 (`gh api repos/.../actions/workflows/aria-merge-runner.yml` → `state`); its last
  run failed on 2026-09-28 06:40Z, so the incident reported a failing lane, not a stopped one.
  `aria-state-maintenance.yml` was disabled on 2026-10-04 after a green run on 2026-10-03 and
  filed nothing; under `maxAgeHours: 48` it would have surfaced on 2026-10-05 as a stale `success`.
- `.github/workflows/scheduled-workflow-watchdog.yml:34` — the per-lane loop begins with
  `listWorkflowRuns`; the workflow's own state is never read. `:101` — age comes from the newest
  executed run; `:161` — the conclusion is `run?.conclusion ?? 'missing'`.
- `.github/manifests/scheduled-workflows.json:31` — `aria-merge-runner.yml` is watched with
  `maxAgeHours: 3`.

Fix: the watchdog reads `actions.getWorkflow` for each lane; a non-`active` state
(`disabled_manually`, `disabled_inactivity`, …) is the incident conclusion and no run judgement can
override it. The disabled lanes remain incidents: whether to re-enable or retire them is the
operator's decision. Test: `tests/invariants/scheduled-workflow-watchdog-disabled-lane.spec.ts`
runs the workflow's real inline script against a fake GitHub API.

## DATA-MEDIUM-019

Evidence (at `main@690470509`):

- CI - Full runs 34018063733, 34745082343, 35497439697, 36304648357 and 37188374410 (every weekly
  run since 2026-09-06): `lint-and-typecheck` fails on one error,
  `apps/ai-service/src/database/migrations/1800000000000-Baseline.ts 43:15 error Unsafe assignment
of an any value @typescript-eslint/no-unsafe-assignment`.
- `scripts/migration/dequalify-tenant-baselines.mjs:268` — the generator emits the probe as
  `const rows: Array<{ missing: string }> = await queryRunner.query(...)`;
  `node_modules/typeorm/query-runner/QueryRunner.d.ts:105` types `query()` as `Promise<any>`, so the
  line is an unchecked `any` → row-type assignment. The other six services' lint policies leave the
  rule off; ai-service's does not.
- `scripts/ci/affected-target-policy.json:56` — ai-service lint is quarantined in the affected lane
  (INFRA-MEDIUM-154, expires 2026-10-31), so the PR that landed the probe never ran it and only the
  weekly full lane did.

Fix: the generator binds the result to `unknown` and narrows it with `Array.isArray` (fails closed
on any other shape); `--apply` re-emitted the probe in all seven Baselines, changing only the two
probe lines in each. No SQL changes, so no ledger or replay effect, but the PR body needs a
`MIGRATION-IMMUTABLE-OK:` line for `migration-immutability-witness`. Test:
`tests/invariants/tenant-baseline-postcondition.spec.ts` pins the emitted shape and that the
committed Baselines are exactly what the generator emits (`[noop]` on a dry run).

## INFRA-MEDIUM-205

Evidence (at `main@690470509`):

- CI - Full runs 35497439697, 36304648357 and 37188374410:
  `##[error]The action 'Run all tests' has timed out after 35 minutes.` In 37188374410 every target
  that finished was green (50 of 52); `farm-service:test` and `messaging-module:test` were still
  running at the kill. Per-target completion times against run 34745082343 (09-13) are uniformly
  10-20% later: growth, not a hang.
- `.github/workflows/ci-full.yml:141` (`timeout-minutes: 45`) and `:213` (`timeout-minutes: 35`)
  were derived from `tests/invariants/ci-timeout-budget-ssot.spec.ts:59` / `:61` — job max 29.05,
  step max 25.9, measured 2026-08-06.
- Step durations of the run's own history: 27.85 (09-01), 29.08 (09-06), 31.18 (09-13), then
  killed at 34.48, 35.22, 35.20.

Fix: re-measured over the 14 newest completed runs (job median 30.79, p90 32.33, max 34.43; step
max 31.18) and, because a kill point is only a lower bound, the kill points as well (step 35.22,
job 39.25). The spec's own factors give step ≥ 47.5 → 50 and job ≥ 58.9 → 60; prologue 4.3 + 50 <
60 keeps the step budget firing first. The spec records the new distribution and asserts the kill
points too. The first run at the new budget is the first uncensored measurement; re-tighten from it.

## INFRA-MEDIUM-206

Evidence (at `main@b5be2c1fd`):

- CI - Full run 34745082343 (2026-09-13), the newest run whose test step completed: `coverage
  evidence contract failed: … coverage ROSE and the baseline was left behind … Re-pin it: node
tools/quality/coverage-evidence.js --write` for admin-api, auth, billing, farm, hr and sensor. The
  run has no artifacts.
- `.github/workflows/ci-full.yml:221` — `Verify coverage evidence` fails on any gain of a point or
  more; `:224` — `Upload coverage evidence` carries no `if:`, so it is skipped after that failure.
- `tools/quality/coverage-evidence.js:130` — the refusal's remedy is computed from the run's LCOV,
  which only this lane produces for the whole suite.

Fix: `Run all tests` has `id: tests` and the upload runs on
`${{ !cancelled() && steps.tests.outcome == 'success' }}`, so a refusal leaves the evidence it names.
Test: `tests/invariants/coverage-evidence-contract.spec.ts`. The re-pin itself still needs one
completed CI - Full run.
