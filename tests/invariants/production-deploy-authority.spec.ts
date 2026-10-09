/**
 * Invariant — every job of a production deploy lane runs with least privilege,
 * and every job that can reach production credentials proves EXACT CURRENT
 * protected-`main` authority as its first step (INFRA-CRITICAL-080).
 *
 * # WHAT this enforces, per lane in PRODUCTION_DEPLOY_WORKFLOWS
 *
 *   1. The workflow-level `permissions:` grants no write scope. A job that
 *      needs to write declares it itself.
 *   2. Every job declares its own `permissions:`, so no job inherits a scope it
 *      was never reviewed for.
 *   3. Every production-secret-bearing job — one bound to an Environment or
 *      reading any `secrets.*` other than the run-scoped `GITHUB_TOKEN` —
 *        a. carries `github.ref == 'refs/heads/main'` in its job `if:`, so a
 *           non-main dispatch never starts the job and never materialises an
 *           Environment secret;
 *        b. runs the `protected-main-authority` step FIRST: before checkout,
 *           before any action, before any step that names a secret. The step
 *           itself names no secret and proves the ref is `main`, the workflow
 *           revision is the run's revision, and the run's revision IS the
 *           current head of `main` on the remote.
 *
 * # WHY
 *
 * The production deploy workflow granted `contents: write`, `packages: write`
 * and `id-token: write` at workflow level to jobs that only read, and its
 * Environment-bound jobs relied on partial event predicates. A re-run of an old
 * run, or a dispatch whose build finished after `main` had moved, carried a
 * stale revision into the jobs that hold the droplet SSH key. INFRA-CRITICAL-045
 * fixed the same class for the backup lane; this is its deploy-lane recurrence.
 * The development lane is listed too: it deploys to the same droplet with the
 * same `DROPLET_*` credentials, so "production deploy" is decided by the
 * credentials a job holds, not by the workflow's name.
 *
 * The authority step cannot be a repository script or a local composite
 * action: both need a checkout, and the step exists to run before checkout.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const WORKFLOW_DIR = resolve(__dirname, '..', '..', '.github', 'workflows');

const PRODUCTION_DEPLOY_WORKFLOWS = ['deploy-digitalocean.yml', 'deploy-development.yml'] as const;

const AUTHORITY_STEP_ID = 'protected-main-authority';

interface WorkflowStep {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly uses?: unknown;
  readonly run?: unknown;
}

interface WorkflowJob {
  readonly if?: unknown;
  readonly environment?: unknown;
  readonly permissions?: unknown;
  readonly steps?: unknown;
  readonly uses?: unknown;
}

interface WorkflowDocument {
  readonly permissions?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(file: string): WorkflowDocument {
  return yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as WorkflowDocument;
}

function stepsOf(job: WorkflowJob): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

/**
 * `secrets.<NAME>` reads inside `${{ ... }}` expressions — the only place the
 * runner resolves a secret. Matching the whole serialised step instead would
 * flag a file path such as `walg-load-secrets.sh`.
 */
function secretNames(value: unknown): string[] {
  const names = new Set<string>();
  for (const expression of JSON.stringify(value ?? null).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const match of (expression[1] ?? '').matchAll(
      /(?<![A-Za-z0-9_.])secrets\.([A-Za-z0-9_]+)/g,
    )) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names];
}

/** Secrets other than the run-scoped `GITHUB_TOKEN`. */
function productionSecretNames(value: unknown): string[] {
  return secretNames(value).filter((name) => name !== 'GITHUB_TOKEN');
}

function isProductionSecretBearing(job: WorkflowJob): boolean {
  return job.environment !== undefined || productionSecretNames(job).length > 0;
}

/** A step that can hand the job new code or a secret. */
function isPrivilegedStep(step: WorkflowStep): boolean {
  return typeof step.uses === 'string' || secretNames(step).length > 0;
}

function writeScopes(permissions: unknown): string[] {
  if (permissions === undefined || permissions === null) return ['<undeclared>'];
  if (typeof permissions === 'string') {
    return permissions === 'read-all' ? [] : [permissions];
  }
  return Object.entries(permissions as Record<string, unknown>)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

describe('production deploy lanes prove exact protected-main authority (INFRA-CRITICAL-080)', () => {
  for (const file of PRODUCTION_DEPLOY_WORKFLOWS) {
    describe(file, () => {
      const workflow = readWorkflow(file);
      const jobs = Object.entries(workflow.jobs ?? {});

      it('grants no write scope at workflow level', () => {
        expect({ file, write: writeScopes(workflow.permissions) }).toEqual({ file, write: [] });
      });

      it('declares permissions on every job', () => {
        const undeclared = jobs
          .filter(([, job]) => job.uses === undefined && job.permissions === undefined)
          .map(([name]) => name);
        expect(undeclared).toEqual([]);
      });

      it('has production-secret-bearing jobs to protect (the scan cannot pass vacuously)', () => {
        expect(jobs.filter(([, job]) => isProductionSecretBearing(job)).length).toBeGreaterThan(0);
      });

      for (const [jobName, job] of jobs.filter(([, candidate]) =>
        isProductionSecretBearing(candidate),
      )) {
        it(`${jobName}: never starts off main`, () => {
          expect(String(job.if ?? '')).toMatch(/github\.ref\s*==\s*'refs\/heads\/main'/);
        });

        it(`${jobName}: proves exact current main before checkout, actions or secrets`, () => {
          const steps = stepsOf(job);
          const authorityIndex = steps.findIndex((step) => step.id === AUTHORITY_STEP_ID);
          const firstPrivilegedIndex = steps.findIndex(isPrivilegedStep);

          expect({ jobName, authorityIndex }).toEqual({ jobName, authorityIndex: 0 });
          expect(firstPrivilegedIndex).toBeGreaterThan(authorityIndex);

          const authority = steps[authorityIndex] ?? {};
          const run = typeof authority.run === 'string' ? authority.run : '';
          expect(authority.uses).toBeUndefined();
          expect(secretNames(authority)).toEqual([]);
          expect(run).toContain('test "${GITHUB_REF}" = \'refs/heads/main\'');
          expect(run).toContain('test "${GITHUB_WORKFLOW_SHA}" = "${GITHUB_SHA}"');
          expect(run).toContain('repos/${GITHUB_REPOSITORY}/git/ref/heads/main');
          expect(run).toMatch(/"\$\{current_main\}" != "\$\{GITHUB_SHA\}"/);
        });
      }
    });
  }
});
