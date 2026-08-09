/**
 * Platform-wide invariant — a job that uploads SARIF must declare the grant
 * that lets the upload succeed.
 *
 * # Why this exists
 *
 * `security-trivy.yml:trivy-image-scan` and `security-snyk.yml:snyk-infrastructure`
 * both ran their scanner, both found real vulnerabilities, and both ended with
 * `Resource not accessible by integration` on the upload step. Neither job
 * declared `security-events: write`, and the repository default is not enough.
 * The sibling job in the very same Trivy workflow declares it, which is why one
 * scanner's findings reached the Security tab and the other's were discarded.
 *
 * The failure mode is the dangerous one: the scan looks like it ran, the job is
 * red for a *different* reason (Trivy exits non-zero on HIGH/CRITICAL findings),
 * and the actual finding stream silently goes nowhere. A security control whose
 * output is thrown away is worse than no control, because the red is read as
 * "the scan is noisy" rather than "the results are missing".
 *
 * # What a failure means
 *
 * The named job runs `github/codeql-action/upload-sarif` without
 * `security-events: write` in scope. Add it to that job's `permissions:` block
 * (preferred — least privilege stays per-job) or to the workflow's top-level
 * `permissions:`. Declaring it does not make findings disappear; it makes them
 * visible, which is the point.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

const repoRoot = resolve(__dirname, '../..');
const workflowsDir = join(repoRoot, '.github/workflows');

type Permissions = Record<string, string> | string | undefined;

interface Step {
  readonly uses?: string;
}

interface Job {
  readonly permissions?: Permissions;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly permissions?: Permissions;
  readonly jobs?: Record<string, Job>;
}

function workflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function grantsSecurityEvents(permissions: Permissions): boolean {
  // `permissions: write-all` grants everything; a map must name the scope.
  if (permissions === 'write-all') return true;
  if (typeof permissions !== 'object' || permissions === null) return false;
  return permissions['security-events'] === 'write';
}

/** Jobs that call the SARIF uploader, as `file:job`, with their effective grant. */
function sarifUploadingJobs(): { id: string; granted: boolean }[] {
  const found: { id: string; granted: boolean }[] = [];
  for (const file of workflowFiles()) {
    let workflow: Workflow;
    try {
      workflow = parse(readFileSync(join(workflowsDir, file), 'utf8')) as Workflow;
    } catch {
      continue;
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const uploadsSarif = (job.steps ?? []).some((step) =>
        (step.uses ?? '').includes('upload-sarif'),
      );
      if (!uploadsSarif) continue;
      // A job-level block replaces the workflow-level one outright, so the
      // effective grant is the job's when it has one.
      const effective = job.permissions ?? workflow.permissions;
      found.push({ id: `${file}:${jobName}`, granted: grantsSecurityEvents(effective) });
    }
  }
  return found;
}

describe('SARIF upload permissions', () => {
  it('grants security-events: write to every job that uploads SARIF', () => {
    const ungranted = sarifUploadingJobs()
      .filter((job) => !job.granted)
      .map((job) => job.id);

    expect(ungranted).toEqual([]);
  });

  it('still finds the SARIF uploaders it is meant to guard', () => {
    // Guards the guard: if the uploader action is renamed or the workflows are
    // restructured, this test would pass vacuously while checking nothing.
    expect(sarifUploadingJobs().length).toBeGreaterThan(0);
  });
});
