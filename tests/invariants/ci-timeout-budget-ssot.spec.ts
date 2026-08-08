/**
 * CI-TIMEOUT-BUDGET — a CI timeout is a hang detector, not a performance budget.
 *
 * `.github/workflows/ci-full.yml` job `test` carried `timeout-minutes: 30` against a
 * measured distribution of median 23m29s / p90 25m41s / max 29m03s, and one run was
 * killed at 30m23s. A detector whose p90 sits at 86% of its budget is not detecting
 * hangs — it is sampling runner load. When it fired, the job reported `cancelled` and
 * `build-status` rendered that as "Tests failed": a DURATION problem delivered to the
 * reader as a TEST problem.
 *
 * The numbers live HERE and not only in a YAML comment, because a comment is not
 * re-checked — the very comment this change had to repair (`lint-and-typecheck`'s,
 * which still claimed "test 30") is the proof. This spec owns:
 *
 *   1. the measured distribution the budgets derive from (MEASURED_*);
 *   2. the derivation rule — each budget clears its OWN observed maximum. The step
 *      budget answers to the step's distribution and the job budget to the job's.
 *      Deriving the step budget from the job's maximum inflates it and collapses the
 *      gap below, which is exactly how a two-level budget becomes decorative;
 *   3. that gap: the step budget sits below the job's by more than the worst observed
 *      prologue, so an overrun fails AS A NAMED STEP instead of being swallowed by an
 *      anonymous job cancellation;
 *   4. the cross-lane ordering — ci-full's `test` runs `nx run-many --target=test
 *      --all` over every project and honours no quarantine, so its budget can never
 *      sit below the affected lane's budget for the same target;
 *   5. that every job in the full lane declares a budget at all. A job without
 *      `timeout-minutes` inherits GitHub's 360-minute default and has no detector —
 *      `build-status`, a required context, was in exactly that state;
 *   6. that the aggregate reports results rather than inventing causes.
 *
 * Same shape as the deploy-side rule in `deploy-ssot-contract.spec.ts` ("keeps one
 * final capacity diagnostic bounded below deploy and maintenance budgets"), which
 * asserts inner-command budget < job budget for deploy-capacity-maintenance.yml.
 *
 * WHEN THIS FAILS: re-measure the job AND the step over ~14 completed runs, update
 * MEASURED_* and the budgets together, and update the job header in ci-full.yml.
 * Raising a budget without re-measuring is the defect this spec exists to stop.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CI_FULL = '.github/workflows/ci-full.yml';
const CI_AFFECTED = '.github/workflows/ci-affected.yml';

/**
 * Wall clock of `ci-full.yml` job `test`, 14 completed runs measured 2026-08-06.
 * Minutes, decimal. `jobMax` is the job; `stepMax` is the `Run all tests` step alone;
 * `prologueMax` is everything outside that step (service-container pull and health
 * wait, checkout, setup-node, Nx cache restore, npm ci, Rust toolchain, coverage
 * verify, artifact upload).
 */
const MEASURED = {
  jobMedian: 23.48,
  jobP90: 25.68,
  jobMax: 29.05,
  jobKilledAt: 30.38,
  stepMax: 25.9,
  prologueMax: 4.3,
} as const;

/**
 * A detector must clear the tail by more than the noise already observed. The spread
 * above the median is ~24%; these factors clear each observed maximum by more than one
 * further spread. The step gets the tighter factor because its budget is the specific
 * detector; the job budget is an outer backstop and carries the looser one.
 */
const MIN_STEP_BUDGET_FACTOR = 1.35;
const MIN_JOB_BUDGET_FACTOR = 1.5;

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly 'timeout-minutes'?: number;
}

interface WorkflowJob {
  readonly 'timeout-minutes'?: number;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as Workflow;
}

function job(workflowPath: string, jobId: string): WorkflowJob {
  const found = readWorkflow(workflowPath).jobs?.[jobId];
  if (found === undefined) throw new Error(`${workflowPath}: job \`${jobId}\` not found`);
  return found;
}

function step(workflowPath: string, jobId: string, stepName: string): WorkflowStep {
  const found = job(workflowPath, jobId).steps?.find((candidate) => candidate.name === stepName);
  if (found === undefined) {
    throw new Error(`${workflowPath}:${jobId}: step "${stepName}" not found`);
  }
  return found;
}

/**
 * Doubles as the non-vacuity guard: a missing budget throws by name rather than
 * silently comparing `undefined`, which would pass every `toBeGreaterThan`.
 */
function budgetMinutes(owner: WorkflowJob | WorkflowStep, label: string): number {
  const value = owner['timeout-minutes'];
  if (typeof value !== 'number') throw new Error(`${label}: no timeout-minutes declared`);
  return value;
}

describe('CI timeout budgets are hang detectors, not performance budgets', () => {
  it('derives each budget from its own measured maximum', () => {
    const testJob = job(CI_FULL, 'test');
    const runAllTests = step(CI_FULL, 'test', 'Run all tests');

    // Premise of every number below: this step is still the single heavy fan-out over
    // every project. If the command changes, the measured distribution no longer
    // describes it and both budgets must be re-derived.
    expect(runAllTests.run).toBe('npm run test:all -- --coverage');

    const jobBudget = budgetMinutes(testJob, `${CI_FULL}:test`);
    const stepBudget = budgetMinutes(runAllTests, `${CI_FULL}:test/Run all tests`);

    expect(jobBudget).toBe(45);
    expect(stepBudget).toBe(35);

    // The rule, not just the numbers — these fail for the real reason ("this budget is
    // 1.03x the p90, it is not a detector") rather than merely noticing an edit.
    expect(stepBudget).toBeGreaterThanOrEqual(MEASURED.stepMax * MIN_STEP_BUDGET_FACTOR);
    expect(jobBudget).toBeGreaterThanOrEqual(MEASURED.jobMax * MIN_JOB_BUDGET_FACTOR);

    // Above the one run the old budget actually killed.
    expect(jobBudget).toBeGreaterThan(MEASURED.jobKilledAt);

    // Sanity on the recorded distribution itself, so a careless edit to MEASURED
    // cannot silence the rule by shrinking its own input.
    expect(MEASURED.jobMax).toBeGreaterThan(MEASURED.jobP90);
    expect(MEASURED.jobP90).toBeGreaterThan(MEASURED.jobMedian);
    expect(MEASURED.jobMax).toBeGreaterThan(MEASURED.stepMax);
  });

  it('keeps the step budget able to fire before the job budget cancels the job', () => {
    const jobBudget = budgetMinutes(job(CI_FULL, 'test'), `${CI_FULL}:test`);
    const stepBudget = budgetMinutes(
      step(CI_FULL, 'test', 'Run all tests'),
      `${CI_FULL}:test/Run all tests`,
    );

    // The whole point of two levels. If the worst prologue plus a step that uses its
    // full budget can reach the job budget, the job is cancelled first, the step
    // budget never fires, and the `cancelled`-instead-of-`failure` misreport returns.
    expect(MEASURED.prologueMax + stepBudget).toBeLessThan(jobBudget);
  });

  it('never budgets the unfiltered full lane below the quarantined affected lane', () => {
    const fullBudget = budgetMinutes(job(CI_FULL, 'test'), `${CI_FULL}:test`);
    const affectedBudget = budgetMinutes(job(CI_AFFECTED, 'test'), `${CI_AFFECTED}:test`);
    const affectedFanout = step(CI_AFFECTED, 'test', 'Run tests (affected only)');
    const affectedStepBudget = budgetMinutes(
      affectedFanout,
      `${CI_AFFECTED}:test/Run tests (affected only)`,
    );

    // Premise: the affected lane is target-filtered and quarantine-aware, the full
    // lane is not. Whatever the budgets are, the lane that can never run FEWER targets
    // cannot carry the smaller budget.
    expect(affectedFanout.run).toContain('affected-target-policy.sh --target test');
    expect(fullBudget).toBeGreaterThanOrEqual(affectedBudget);

    // The sibling's own two-level shape is the precedent this file generalises.
    expect(affectedStepBudget).toBeLessThan(affectedBudget);
  });

  it('gives every job in the full lane a hang detector', () => {
    const jobs = readWorkflow(CI_FULL).jobs ?? {};
    const jobIds = Object.keys(jobs);

    // Non-vacuity: prove the parse produced the real job set before filtering it.
    expect(jobIds).toEqual(
      expect.arrayContaining([
        'lint-and-typecheck',
        'test',
        'build',
        'generate-sri-hashes',
        'deploy-ssot-gates',
        'security-scan',
        'license-check',
        'build-status',
      ]),
    );

    const withoutBudget = jobIds.filter((id) => typeof jobs[id]?.['timeout-minutes'] !== 'number');

    expect(withoutBudget).toEqual([]);
  });

  it('reports the aggregate verdict without inventing a cause', () => {
    const script = (job(CI_FULL, 'build-status').steps ?? [])
      .map((candidate) => candidate.run ?? '')
      .join('\n');

    expect(script).not.toBe('');

    // `cancelled` is a budget overrun OR a superseded run; `failure` includes a step
    // that blew its own timeout. The aggregate cannot tell any of these from a real
    // defect in the job's subject, so it must print the result it has.
    for (const inventedCause of ['Tests failed', 'Build failed', 'Lint/Typecheck failed']) {
      expect(script).not.toContain(inventedCause);
    }
    expect(script).toContain('result=');

    // Pinned by tools/gates/required-status-checks.ts — the success string is part of
    // the branch-protection contract, not decoration.
    expect(script).toContain('All critical checks passed');
  });
});
