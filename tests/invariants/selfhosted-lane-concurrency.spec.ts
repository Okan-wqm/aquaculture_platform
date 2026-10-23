/**
 * ARIA-MEDIUM-277 — no lane can silently cancel another lane's pending run.
 *
 * WHY. cycle, executor and capability-probe all declared the ONE
 * workflow-level group `aria-selfhosted-workspace`. A GitHub concurrency
 * group holds a single pending slot and a newly arriving run EVICTS the
 * queued one, so any dispatch of one lane cancelled another lane's queued
 * run: the dataflow watchdog's CRITICAL dispatch evicted a pending executor,
 * the executor chained the next cycle into the slot, and the hourly probe
 * (measured 3-7 runs/day against a 24-slot cadence) was itself the evictor
 * before ORPHAN-713 moved it out. The starvation was invisible: an evicted
 * run is cancelled-before-any-job, which no verdict reads as a failure.
 *
 * HOW. Every self-hosted lane keeps a concurrency group (a lane's own
 * duplicate may still evict its own pending run — that is dedup, not
 * starvation) but no group may be declared by two different workflows: a
 * pending slot that another lane can take is the defect. The serialization
 * the shared group used to lend the one shared workspace is carried instead
 * by the host workspace lock
 * (.github/actions/selfhosted-workspace-lock, pinned by
 * aria-kernel/tests/test_z1_store_isolation.py — the ORPHAN-712 owner).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

interface WorkflowJob {
  readonly 'runs-on'?: string | readonly string[];
}

interface WorkflowDoc {
  readonly concurrency?: {
    readonly group?: string;
    readonly 'cancel-in-progress'?: boolean;
  };
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

interface WorkflowFile {
  readonly name: string;
  readonly doc: WorkflowDoc;
}

function isSelfHosted(job: WorkflowJob): boolean {
  const runsOn = job['runs-on'];
  if (typeof runsOn === 'string') return runsOn === 'self-hosted';
  return Array.isArray(runsOn) && runsOn.includes('self-hosted');
}

function loadWorkflows(): WorkflowFile[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({
      name,
      doc: yaml.load(readFileSync(join(WORKFLOWS_DIR, name), 'utf8')) as WorkflowDoc,
    }));
}

function selfHostedWorkflows(files: readonly WorkflowFile[]): WorkflowFile[] {
  return files.filter((file) => Object.values(file.doc.jobs ?? {}).some(isSelfHosted));
}

function groupDeclarants(files: readonly WorkflowFile[], group: string): readonly string[] {
  return files.filter((file) => file.doc.concurrency?.group === group).map((file) => file.name);
}

describe('self-hosted lane concurrency — one lane, one group, no cross-lane eviction', () => {
  const files = loadWorkflows();
  const selfHosted = selfHostedWorkflows(files);

  // The derivation itself is pinned: if nothing runs on a self-hosted
  // runner anymore, this spec silently stops checking anything.
  it('derives at least four self-hosted lanes from the workflow files', () => {
    expect(selfHosted.map((file) => file.name).sort()).toEqual([
      'aria-agent-executor.yml',
      'aria-auto-cycle.yml',
      'aria-daily-report.yml',
      'aria-runner-capability-probe.yml',
      'dataflow-integrity-watchdog.yml',
    ]);
  });

  it('every self-hosted lane declares a concurrency group that never cancels a running job', () => {
    expect(selfHosted.length).toBeGreaterThan(0);
    for (const file of selfHosted) {
      expect({ file: file.name, group: file.doc.concurrency?.group }).toEqual({
        file: file.name,
        group: expect.any(String),
      });
      expect(file.doc.concurrency?.['cancel-in-progress'] ?? false).toBe(false);
    }
  });

  it('no concurrency group is declared by two different workflows', () => {
    const shared = new Map<string, string[]>();
    for (const file of selfHosted) {
      const group = file.doc.concurrency?.group;
      if (!group) continue;
      // A hosted workflow squatting on a self-hosted lane's group name is
      // the same eviction vector as two self-hosted lanes sharing it, so
      // the declarant scan covers every workflow file.
      const declarants = groupDeclarants(files, group);
      if (declarants.length > 1) shared.set(group, [...declarants]);
    }
    expect([...shared.entries()]).toEqual([]);
  });
});
