import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WATCHDOG_PATH = join(REPO_ROOT, '.github', 'workflows', 'aria-external-watchdog.yml');
const MANIFEST_PATH = join(REPO_ROOT, '.github', 'manifests', 'aria-state-watchdog.json');

interface WatchdogManifest {
  stateBranch: { ref: string; maxTipAgeHours: number };
  lanes: { workflow: string; role: string; maxSuccessAgeHours: number }[];
  incidentIssue: { titlePrefix: string; labels: string[] };
}

interface WorkflowDocument {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
}

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('ARIA external watchdog contract', () => {
  const source = read(WATCHDOG_PATH);
  const workflow = yaml.load(source) as WorkflowDocument;
  const manifest = JSON.parse(read(MANIFEST_PATH)) as WatchdogManifest;

  it('never reaches for the ARIA kernel it is watching', () => {
    // THE LOAD-BEARING INVARIANT. Every failure this watchdog exists to catch
    // is a failure of the ARIA runtime, so a dependency on that runtime would
    // silence the alarm at exactly the moment it is needed. The temptation is
    // real and specific: `state checkout` would give the tip in one line, and
    // the restore action is right there in the same repository.
    expect(source).not.toMatch(/aria_kernel/);
    expect(source).not.toMatch(/PYTHONPATH/);
    expect(source).not.toMatch(/restore-aria-state/);
    expect(source).not.toMatch(/\.aria-state-store/);
    expect(source).not.toMatch(/setup-aria-kernel/);
  });

  it('reads every threshold from the manifest instead of carrying its own copy', () => {
    // A threshold inlined here is a threshold an operator cannot change
    // without a code review, and a second copy of one is how two numbers
    // start disagreeing about the same deadline.
    expect(source).toContain('aria-state-watchdog.json');
    expect(source).toContain('manifest.stateBranch.maxTipAgeHours');
    expect(source).toContain('lane.maxSuccessAgeHours');
    // No THRESHOLD may be a literal — checked at the comparison, which is the
    // shape the risk actually takes (`age > 50`). An earlier version of this
    // assertion scanned for the bare number anywhere and went red on
    // `per_page: 50`, a pagination size: a test that fails for a reason it did
    // not mean is the thing this suite exists to prevent, not to commit.
    const comparisons = [...source.matchAll(/[<>]=?\s*(\d[\d_]*)/g)].map((match) => match[1]);
    expect(comparisons).toEqual([]);
    expect(manifest.stateBranch.maxTipAgeHours).toBeGreaterThan(0);
    expect(manifest.lanes.every((lane) => lane.maxSuccessAgeHours > 0)).toBe(true);
  });

  it('watches the branch tip, not merely whether the lanes ran', () => {
    // The distinction this watchdog exists for: a lane can run green every
    // night and publish nothing (ORPHAN-CRITICAL-484's shape), which a
    // run-status watchdog reads as health. The tip only moves on an accepted
    // snapshot, so it is the one signal that cannot be faked by a green run.
    expect(source).toContain('getBranch');
    expect(manifest.stateBranch.ref).toBe('aria/state');
    expect(source).toContain('listWorkflowRuns');
    const laneWorkflows = manifest.lanes.map((lane) => lane.workflow).sort();
    expect(laneWorkflows).toEqual(['aria-agent-executor.yml', 'aria-auto-cycle.yml']);
  });

  it('fails the run when it reports a stall', () => {
    // A watchdog that files an issue and exits green is a watchdog whose reds
    // nobody will believe twice — and green is what a scheduled-run watcher
    // upstream would see.
    expect(source).toContain('core.setFailed');
  });

  it('separates an unreadable branch from a stale one', () => {
    // "The branch is gone" and "the branch has not moved" send an operator to
    // different places. Collapsing them into one number is the defect class
    // this session kept closing: a status nobody chose is not a diagnosis.
    expect(source).toContain('is unreachable — this is not a stall');
  });

  it('asks for no more permission than reporting needs', () => {
    expect(workflow.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'write',
    });
  });

  it('runs on a schedule that follows both lanes it watches', () => {
    const schedule = (workflow.on as { schedule?: { cron: string }[] })?.schedule;
    expect(schedule).toHaveLength(1);
    const [minute, hour] = schedule![0]!.cron.split(' ');
    const watchdogHour = Number(hour);
    expect(Number.isInteger(watchdogHour)).toBe(true);
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    // Both watched lanes run before 06:00 UTC; the watchdog must judge after
    // them, or it grades a night that has not happened yet.
    expect(watchdogHour).toBeGreaterThan(6);
    expect(watchdogHour).toBeLessThan(24);
  });

  it('checks out without credentials it does not need', () => {
    const steps = workflow.jobs?.watch?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();
    expect(checkout!.with?.['persist-credentials']).toBe(false);
  });
});
