/**
 * MF-1 (PROC-HIGH-039, PROC-LOW-038) — no lane moves main to record a closure.
 *
 * ## Why
 *
 * Each merge that carried a `Closes:` trailer started a second main move: the
 * closure-reconcile lane ran on the push, wrote RESOLVED into findings.jsonl,
 * opened a PR and auto-merged it. 63 of 157 merges to main in 14 days were
 * those PRs, each one made every open PR BEHIND, and main's push run stayed
 * red until it landed (MF-DESIGN §1). Once RESOLVED is derived at read time
 * (finding-registry-projection.spec.ts) the lane, the commands it ran, the
 * debt-plan retirement it performed, the specs that pinned its shape and the
 * single-writer runbook built on its premise have nothing left to do. A lane
 * that writes the registry on a push to main is the shape that must not come
 * back.
 *
 * ## What this pins (MF-DESIGN §5 MF-1, §7 T8 for MF-1)
 *
 *   - no workflow triggered by a push to main writes docs/reviews/_registry;
 *   - finding-closure-reconcile.yml, its role row, its secret-consumer text
 *     and its kernel workflow contract are gone;
 *   - the drift spec, the self-heal spec and docs/runbooks/registry-single-writer.md
 *     are gone, and no active file links the runbook;
 *   - `findings:close`, `gates:debt-plan:retire-resolved` and
 *     `retireResolvedRows` are gone; the active guides name no close or
 *     reconcile ceremony;
 *   - closes-footer-check verifies the chain with the registry CLI instead of
 *     an inline third copy of the hash algebra, and rule-health counts come
 *     from `project --format=csv` instead of the stored state.
 *
 * The merge-driver half of T8 (.gitattributes) belongs to MF-2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';

import * as debtPlanTruth from '../../tools/gates/debt-plan-truth';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const RECONCILE_WORKFLOW = 'finding-closure-reconcile.yml';
const RUNBOOK = 'docs/runbooks/registry-single-writer.md';

interface Step {
  readonly run?: unknown;
  readonly uses?: unknown;
  readonly with?: unknown;
  readonly env?: unknown;
}

interface Workflow {
  readonly file: string;
  readonly on: unknown;
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

function loadWorkflows(): Workflow[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const doc = YAML.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as {
        on?: unknown;
        jobs?: Workflow['jobs'];
      } | null;
      return { file, on: doc?.on, jobs: doc?.jobs ?? {} };
    });
}

/** True when a push to main triggers the workflow. */
function pushesToMain(trigger: unknown): boolean {
  if (trigger === 'push') return true;
  if (Array.isArray(trigger)) return trigger.includes('push');
  if (trigger === null || typeof trigger !== 'object' || !('push' in trigger)) return false;
  const push = (trigger as { push?: { branches?: unknown } | null }).push;
  const branches = push?.branches;
  return !Array.isArray(branches) || branches.includes('main');
}

const MUTATING_REGISTRY_COMMAND =
  /finding-registry\.ts\s+(?:close|reconcile|sweep|add|add-explicit|import-narrative|assign|canonicalize-owner|reopen|rechain-from|dedupe)\b|npm\s+run\s+(?:findings:(?:close|add|sweep)|gates:debt-plan:retire-resolved)\b|debt-plan-truth\.ts\s+--retire-resolved/;
const PUBLISHES = /open-report-pr\.sh|\bgit\s+commit\b|\bgit\s+push\b|\bgh\s+pr\s+create\b/;

function stepText(step: Step): string {
  return JSON.stringify([step.run ?? '', step.with ?? {}, step.env ?? {}]);
}

/** Job names of `workflow` that write the registry: a mutating command, or a published registry path. */
function registryWriters(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs).flatMap(([name, job]) => {
    const steps = job.steps ?? [];
    const texts = steps.map(stepText);
    const publishes = texts.some((text) => PUBLISHES.test(text));
    const writes =
      texts.some((text) => MUTATING_REGISTRY_COMMAND.test(text)) ||
      (publishes && texts.some((text) => text.includes('docs/reviews/_registry')));
    return writes ? [`${workflow.file}:${name}`] : [];
  });
}

function runSteps(file: string): string[] {
  const workflow = loadWorkflows().find((entry) => entry.file === file);
  expect(workflow).toBeDefined();
  return Object.values(workflow?.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => (typeof step.run === 'string' ? step.run : '')),
  );
}

/** Tracked files that mention `needle` (git grep: exit 1 means none). */
function trackedFilesMentioning(needle: string): string[] {
  const result = spawnSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-F', needle], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 1) return [];
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return result.stdout.split('\n').filter(Boolean);
}

/** History that is never rewritten: reviews, plans and the registry's own rows. */
function isHistoricalRecord(rel: string): boolean {
  return /^docs\/(?:reviews|plans|superpowers|aria\/reviews)\//.test(rel);
}

describe('MF-1 — no lane moves main to record a closure', () => {
  const workflows = loadWorkflows();

  it('reads real workflows (the scan is not vacuous)', () => {
    expect(workflows.length).toBeGreaterThan(20);
    expect(workflows.some((workflow) => pushesToMain(workflow.on))).toBe(true);
    // The detector recognises the sweep lane's write, which is scheduled, not a push.
    const sweep = workflows.find((workflow) => workflow.file === 'finding-state-sweep.yml');
    expect(sweep).toBeDefined();
    expect(registryWriters(sweep as Workflow)).not.toEqual([]);
    expect(pushesToMain((sweep as Workflow).on)).toBe(false);
  });

  it('no workflow triggered by a push to main writes docs/reviews/_registry', () => {
    const offenders = workflows
      .filter((workflow) => pushesToMain(workflow.on))
      .flatMap(registryWriters);
    expect(offenders).toEqual([]);
  });

  it('the closure-reconcile lane is gone with its role, its secret consumer text and its kernel contract', () => {
    expect(existsSync(join(WORKFLOW_DIR, RECONCILE_WORKFLOW))).toBe(false);
    const roles = JSON.parse(
      readFileSync(join(REPO_ROOT, '.github/manifests/workflow-roles.json'), 'utf8'),
    ) as { workflows: readonly { workflow: string }[] };
    expect(roles.workflows.map((row) => row.workflow)).not.toContain(RECONCILE_WORKFLOW);
    expect(readFileSync(join(REPO_ROOT, '.github/provisioned-secrets.json'), 'utf8')).not.toContain(
      RECONCILE_WORKFLOW,
    );
    expect(
      readFileSync(
        join(REPO_ROOT, 'aria-kernel/aria_kernel/workflow_contract_registry.py'),
        'utf8',
      ),
    ).not.toMatch(/["']finding-closure-reconcile["']/);
  });

  it('the drift spec, the self-heal spec and the single-writer runbook are gone, and nothing active links the runbook', () => {
    for (const rel of [
      'tests/invariants/finding-registry-closure-drift.spec.ts',
      'tests/invariants/finding-closure-reconcile-selfheal.spec.ts',
      RUNBOOK,
    ]) {
      expect([rel, existsSync(join(REPO_ROOT, rel))]).toEqual([rel, false]);
    }
    const linking = trackedFilesMentioning('registry-single-writer').filter(
      (rel) =>
        !isHistoricalRecord(rel) && rel !== 'tests/invariants/registry-no-main-writer.spec.ts',
    );
    expect(linking).toEqual([]);
  });

  it('close and the debt-plan retirement are gone from the npm surface and the module', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(Object.keys(scripts)).not.toContain('findings:close');
    expect(Object.keys(scripts)).not.toContain('gates:debt-plan:retire-resolved');
    const writers = Object.entries(scripts).filter(([, command]) =>
      /finding-registry\.ts\s+(?:close|reconcile)\b|--retire-resolved/.test(command),
    );
    expect(writers).toEqual([]);
    expect(Object.keys(debtPlanTruth)).not.toContain('retireResolvedRows');
  });

  it('the active guides name no close or reconcile ceremony', () => {
    const ceremony = /finding-registry(?:\.ts)?\s+(?:close|reconcile)\b|findings:close/;
    const guides = [
      'docs/reviews/_registry/README.md',
      '.claude/shared/orchestrator-phases.md',
      '.claude/skills/run-migration-prod.md',
    ];
    expect(
      guides.filter((rel) => ceremony.test(readFileSync(join(REPO_ROOT, rel), 'utf8'))),
    ).toEqual([]);
  });

  it('closes-footer-check verifies the chain through the registry CLI, not an inline copy', () => {
    const runs = runSteps('closes-footer-check.yml');
    const inlineChainCopies = runs.filter((run) => /createHash|prev_hash|content_hash/.test(run));
    expect(inlineChainCopies.length).toBe(0);
    expect(runs.some((run) => /tools\/gates\/finding-registry\.ts\s+verify\b/.test(run))).toBe(
      true,
    );
  });

  it('rule-health counts the registry from the projection, not the stored file', () => {
    const runs = runSteps('rule-health-report.yml');
    const storedFileReaders = runs.filter((run) => run.includes('findings.jsonl'));
    expect(storedFileReaders.length).toBe(0);
    expect(
      runs.some((run) =>
        /tools\/gates\/finding-registry\.ts\s+project\b[^\n]*--format=csv/.test(run),
      ),
    ).toBe(true);
  });
});
