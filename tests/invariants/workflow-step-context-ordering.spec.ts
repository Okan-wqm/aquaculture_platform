/**
 * Platform-wide invariant — a step may only read the `steps` context of a
 * step that ALREADY RAN.
 *
 * # WHAT this forbids
 *
 * Inside one job, `${{ steps.<id>.* }}` must resolve to a step whose `id`
 * is declared EARLIER in the same job's step list. Three shapes are
 * rejected:
 *
 *   1. forward reference — the producing step runs later in the job,
 *   2. self reference    — the step reads its own output,
 *   3. unknown reference — no step in the job carries that `id`.
 *
 * # WHY it exists
 *
 * GitHub Actions does not fail any of the three. It substitutes an EMPTY
 * STRING and runs the step anyway, so the defect surfaces far from its
 * cause, as a downstream validation error about a malformed value.
 *
 * The class was paid for on 2026-09-04: `aria-daily-report` resolved its
 * report date from the restored ARIA state store, then a mechanical rename
 * pointed the enterprise-preflight step (position 5) at
 * `steps.resolved.outputs.date` (position 7). REPORT_DATE was empty on
 * every scheduled run, the declared write path collapsed to
 * `aria-tools/reports/daily/.md`, and the workflow contract refused it. The
 * same rename also gave the `resolved` step its OWN output as an input, so
 * an operator's explicit workflow_dispatch date was silently replaced with
 * an empty string. Both are invisible in review and both are mechanically
 * detectable from the YAML alone, which is what this spec does.
 *
 * Job-level `outputs:` are exempt: they are evaluated after every step has
 * run, so referring to any step in the job is correct there.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const WORKFLOW_DIR = resolve(__dirname, '..', '..', '.github', 'workflows');

/**
 * Only text inside a `${{ ... }}` expression is substituted by the runner, so
 * that is the only place a step reference can exist. Prose that merely NAMES
 * `steps.something` (a WHY comment explaining a past defect, for instance) is
 * not an interpolation and must not be reported. An expression inside a shell
 * comment IS still substituted, so the scan deliberately does not skip those.
 */
const EXPRESSION_BLOCK = /\$\{\{([\s\S]*?)\}\}/g;
const STEP_CONTEXT_REF = /steps\.([A-Za-z0-9_][A-Za-z0-9_-]*)\./g;

type Step = Record<string, unknown> & { id?: unknown; name?: unknown; uses?: unknown };
type Job = Record<string, unknown> & { steps?: unknown };
type Workflow = { jobs?: Record<string, Job> };

interface Violation {
  workflow: string;
  job: string;
  step: string;
  referenced: string;
  kind: 'forward' | 'self' | 'unknown';
}

/**
 * Every `steps.<id>` mentioned anywhere in the step: `env:`, `if:`, `with:`
 * and the `run:` script all interpolate the same context, so the whole step
 * is serialised and scanned rather than a hand-picked set of keys.
 */
function referencedStepIds(step: Step): string[] {
  const serialized = JSON.stringify(step);
  const ids = new Set<string>();
  for (const expression of serialized.matchAll(EXPRESSION_BLOCK)) {
    // A capture group is optional in the type even when the pattern always
    // fills it; skipping the impossible case is cheaper than asserting it away.
    const body = expression[1];
    if (body === undefined) continue;
    for (const match of body.matchAll(STEP_CONTEXT_REF)) {
      const referenced = match[1];
      if (referenced !== undefined) ids.add(referenced);
    }
  }
  return [...ids];
}

function stepLabel(step: Step, index: number): string {
  const name = typeof step.name === 'string' ? step.name : undefined;
  const uses = typeof step.uses === 'string' ? step.uses : undefined;
  return name ?? uses ?? `step[${index}]`;
}

function collectViolations(workflowFile: string): Violation[] {
  const parsed = yaml.load(
    readFileSync(join(WORKFLOW_DIR, workflowFile), 'utf8'),
  ) as Workflow | null;
  const jobs = parsed?.jobs;
  if (!jobs || typeof jobs !== 'object') return [];

  const violations: Violation[] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? (job.steps as Step[]) : [];
    if (steps.length === 0) continue;

    // id -> first position that declares it.
    const positionById = new Map<string, number>();
    steps.forEach((step, index) => {
      if (typeof step?.id === 'string' && !positionById.has(step.id)) {
        positionById.set(step.id, index);
      }
    });

    steps.forEach((step, index) => {
      if (!step || typeof step !== 'object') return;
      for (const referenced of referencedStepIds(step)) {
        const producedAt = positionById.get(referenced);
        if (producedAt === undefined) {
          violations.push({
            workflow: workflowFile,
            job: jobId,
            step: stepLabel(step, index),
            referenced,
            kind: 'unknown',
          });
        } else if (producedAt === index) {
          violations.push({
            workflow: workflowFile,
            job: jobId,
            step: stepLabel(step, index),
            referenced,
            kind: 'self',
          });
        } else if (producedAt > index) {
          violations.push({
            workflow: workflowFile,
            job: jobId,
            step: stepLabel(step, index),
            referenced,
            kind: 'forward',
          });
        }
      }
    });
  }
  return violations;
}

describe('workflow step context ordering', () => {
  const workflowFiles = readdirSync(WORKFLOW_DIR).filter(
    (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
  );

  it('finds workflow files to check', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it('never reads the steps context of a step that has not run yet', () => {
    const violations = workflowFiles.flatMap(collectViolations);
    const rendered = violations.map(
      (v) =>
        `${v.workflow} :: job "${v.job}" :: step "${v.step}" reads ${v.kind} reference steps.${v.referenced}.*`,
    );
    expect(rendered).toEqual([]);
  });
});
