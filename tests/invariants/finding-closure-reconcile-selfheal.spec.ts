/**
 * Workflow invariant — the closure-reconcile lane heals the registry by
 * itself, end to end.
 *
 * # Why this exists
 *
 * The lane already existed and already ran on every push to main — and the
 * registry still went red for ten hours on 2026-09-21. #1652 merged at
 * 04:30Z carrying four `Closes:` trailers; this lane opened #1666 within
 * minutes; the PR then waited for a human until 14:36Z while
 * `finding-registry-closure-drift` failed on every PR anyone opened. The
 * reporter inherits the debt of the merger, so the delay did not hurt the
 * lane that caused it — it hurt every other lane's CI, all day.
 *
 * The same night exposed the second half: two lanes that each append a
 * registry row without folding the other's merge leave main with a stacked
 * tail whose hashes were computed against different parents, and nothing on
 * main repairs it — the fold-and-rechain ritual was performed by hand six
 * times in one night.
 *
 * The contract this spec pins (docs/runbooks/registry-single-writer.md):
 *
 *   1. the lane triggers on every push to main and never cancels a running
 *      heal (a burst of merges queues, it does not race);
 *   2. the registry's health check is read-only first — a break is detected
 *      and named before anything mutates, and a break `verify` cannot name
 *      is refused, not guessed at;
 *   3. the enterprise preflight is persisted BEFORE the first mutation of
 *      the run, whatever kind of mutation follows (heal or reconcile);
 *   4. a stacked tail heals itself: `rechain-from <entry>` then `verify`;
 *   5. the reconcile PR asks for auto-merge the moment it exists, through
 *      the same app token that opened it, and an unavailable auto-merge
 *      (repository setting not yet flipped) is a notice, never a failure —
 *      the lane must not go red for lacking the permission that would make
 *      it autonomous;
 *   6. every wet step also runs for the heal-only case — a broken chain
 *      with zero closures still verifies, re-pins and publishes.
 *
 * # What a failure means
 *
 * Someone edited the lane without carrying the whole contract: a step was
 * reordered past the preflight, a condition dropped the needs_heal arm, or
 * the auto-merge request was made fatal. Restore the shape or amend this
 * spec deliberately — the ten-hour red window is what returning to the old
 * shape costs.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';

const repoRoot = resolve(__dirname, '../..');
const workflowPath = join(repoRoot, '.github/workflows/finding-closure-reconcile.yml');

interface StepShape {
  name?: string;
  if?: string;
  run?: string;
}

function loadSteps(): {
  trigger: Record<string, unknown>;
  concurrency: Record<string, unknown>;
  steps: StepShape[];
} {
  const doc = YAML.parseDocument(readFileSync(workflowPath, 'utf8'));
  expect(doc.errors).toEqual([]);
  const wf = doc.toJS() as {
    on?: Record<string, unknown>;
    concurrency?: Record<string, unknown>;
    jobs?: Record<string, { steps?: StepShape[] }>;
  };
  const job = wf.jobs?.reconcile;
  expect(job).toBeDefined();
  return {
    trigger: (wf.on ?? {}) as Record<string, unknown>,
    concurrency: (wf.concurrency ?? {}) as Record<string, unknown>,
    steps: job?.steps ?? [],
  };
}

function stepNames(steps: StepShape[]): string[] {
  return steps.map((s) => s.name ?? '(unnamed)');
}

function stepByName(steps: StepShape[], name: string): StepShape {
  const found = steps.find((s) => s.name === name);
  expect(found).toBeDefined();
  return found as StepShape;
}

describe('workflow invariant: the closure-reconcile lane heals the registry by itself', () => {
  it('triggers on every push to main and never cancels a running reconcile', () => {
    const { trigger, concurrency } = loadSteps();
    const push = trigger.push as { branches?: string[] } | undefined;
    expect(push?.branches).toEqual(['main']);
    expect(concurrency.group).toBe('finding-closure-reconcile');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('detects the stacked tail read-only, before the plan and any mutation', () => {
    const { steps } = loadSteps();
    const names = stepNames(steps);
    const detect = names.indexOf('Detect a stacked registry tail (read-only)');
    const plan = names.indexOf('Compute reconcile plan (dry run)');
    const preflight = names.indexOf('Persist enterprise workflow preflight');
    expect(detect).toBeGreaterThanOrEqual(0);
    expect(detect).toBeLessThan(plan);
    expect(plan).toBeLessThan(preflight);

    const detectStep = stepByName(steps, 'Detect a stacked registry tail (read-only)');
    expect(detectStep.run).toContain('finding-registry.ts verify');
    expect(detectStep.run).not.toContain('rechain-from');
    // A break verify cannot name is refused here — the lane never guesses
    // which suffix to recompute.
    expect(detectStep.run).toContain('refusing to guess');
  });

  it('persists the preflight before the first mutation, whatever mutates next', () => {
    const { steps } = loadSteps();
    const names = stepNames(steps);
    const preflight = names.indexOf('Persist enterprise workflow preflight');
    const heal = names.indexOf('Heal the stacked registry tail');
    const apply = names.indexOf('Apply reconcile');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(heal).toBeGreaterThan(preflight);
    expect(apply).toBeGreaterThan(preflight);

    const preflightStep = stepByName(steps, 'Persist enterprise workflow preflight');
    expect(preflightStep.if).toContain("steps.plan.outputs.has_changes == 'true'");
    expect(preflightStep.if).toContain("steps.tail.outputs.needs_heal == 'true'");
  });

  it('heals a named break with rechain-from and verifies the repair', () => {
    const { steps } = loadSteps();
    const heal = stepByName(steps, 'Heal the stacked registry tail');
    expect(heal.run).toContain('finding-registry.ts rechain-from');
    expect(heal.run).toContain('finding-registry.ts verify');
    expect(heal.if).toContain("steps.tail.outputs.needs_heal == 'true'");
    expect(heal.if).toContain("steps.plan.outputs.dry_run != 'true'");
  });

  it('requests auto-merge for the reconcile PR and treats an unavailable one as a notice', () => {
    const { steps } = loadSteps();
    const names = stepNames(steps);
    const open = names.indexOf('Open or update reconcile PR');
    const autoMerge = names.indexOf('Request auto-merge for the reconcile PR');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(autoMerge).toBeGreaterThan(open);

    const step = stepByName(steps, 'Request auto-merge for the reconcile PR');
    expect(step.run).toContain('gh pr merge --auto --merge');
    // The unavailability (repository has not flipped allow_auto_merge, or
    // protection forbids it) downgrades to a notice — a heal lane must not
    // fail for lacking the permission that would make it autonomous.
    expect(step.run).toContain('::notice::');
    expect(step.run).not.toContain('::error::');
  });

  it('runs every wet step for the heal-only case too', () => {
    const { steps } = loadSteps();
    const wetNames = [
      'Verify post-reconcile chain integrity',
      'Repin the debt plan to the new chain tip',
      'Mint GitHub App installation token',
      'Open or update reconcile PR',
      'Request auto-merge for the reconcile PR',
    ];
    for (const name of wetNames) {
      const step = stepByName(steps, name);
      expect(step.if).toContain("steps.tail.outputs.needs_heal == 'true'");
    }
  });

  it('routes a derivation failure through the heal instead of dying before its own repair', () => {
    const { steps } = loadSteps();
    const plan = stepByName(steps, 'Compute reconcile plan (dry run)');
    // A stacked tail can break `reconcile --dry-run` itself; with a detected
    // break the failure routes forward (has_changes=true) so the heal runs
    // and the wet apply re-derives from the repaired chain.
    expect(plan.run).toContain('NEEDS_HEAL');
    expect(plan.run).toContain('exit 1');
  });
});
