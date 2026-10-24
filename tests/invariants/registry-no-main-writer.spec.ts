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
 * The merge-driver half of T8 (.gitattributes) is the MF-2 block at the end of this file.
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

/**
 * MF-2 (MF-DESIGN §5 MF-2, §7 T8 for MF-2) — with findings.jsonl frozen and
 * every change an event in its finding's own file, nothing is left for a merge
 * driver to heal and nothing may write the frozen file:
 *
 *   - .gitattributes binds no merge attribute under docs/reviews/_registry/
 *     (GitHub honours none, and git's own text merge is the correct one for
 *     per-finding files: a same-finding race must conflict);
 *   - the driver, its merge function, its installer, its registration file,
 *     its `prepare` step and its spec are gone, and the kernel's branch-update
 *     modules no longer reason about it;
 *   - the one-off seed/patch scripts that wrote findings.jsonl are gone, and
 *     the CLI has no `writeRegistry` for it;
 *   - the sweep lane publishes the event files it writes, and its kernel
 *     write contract admits exactly those paths.
 */
describe('MF-2 — no merge driver and no writer of the frozen findings.jsonl', () => {
  const DRIVER_FILES = [
    'tools/gates/finding-registry-merge.ts',
    'tools/gates/finding-registry-merge-driver.ts',
    'tools/gates/install-git-merge-drivers.mjs',
    'tools/gates/git-merge-drivers.json',
    'tests/invariants/finding-registry-merge-driver.spec.ts',
  ];
  const ONE_OFF_WRITERS = [
    'tools/scripts/seed-finding-registry.ts',
    'tools/scripts/seed-claude-audit-findings.ts',
    'tools/scripts/patch-registry-phase2b.ts',
    'tools/audit/seed-audit-findings.ts',
    'tools/audit/migrate-schema-violations.ts',
    'tools/audit/registry-rechain-after-squash.ts',
  ];
  const EVENT_PATH_CONTRACT = String.raw`^docs/reviews/_registry/findings/[A-Z0-9]+/[A-Z0-9-]+\.jsonl$`;

  it('.gitattributes binds no merge attribute under docs/reviews/_registry/', () => {
    const bound = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .filter((line) => {
        const [pattern = '', ...attributes] = line.split(/\s+/);
        return (
          pattern.startsWith('docs/reviews/_registry') &&
          attributes.some((attribute) => /^-?merge(?:=|$)/.test(attribute))
        );
      });
    expect(bound).toEqual([]);
  });

  it('the driver, its installer, its registration, its prepare step and its spec are gone', () => {
    expect(DRIVER_FILES.filter((rel) => existsSync(join(REPO_ROOT, rel)))).toEqual([]);
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.prepare ?? '').not.toContain('install-git-merge-drivers');
    const mentioning = [
      ...trackedFilesMentioning('merge=findings-registry'),
      ...trackedFilesMentioning('finding-registry-merge'),
      ...trackedFilesMentioning('install-git-merge-drivers'),
    ].filter(
      (rel) =>
        !isHistoricalRecord(rel) && rel !== 'tests/invariants/registry-no-main-writer.spec.ts',
    );
    expect([...new Set(mentioning)].sort()).toEqual([]);
    // The kernel's branch-update lane reasoned about the driver it did not need;
    // with no driver left, neither module names it.
    const kernelModules = [
      'aria-kernel/aria_kernel/pr_branch_update.py',
      'aria-kernel/aria_kernel/branch_update_lineage.py',
    ];
    expect(
      kernelModules.filter((rel) =>
        readFileSync(join(REPO_ROOT, rel), 'utf8').includes('findings-registry'),
      ),
    ).toEqual([]);
  });

  it('the one-off writers of findings.jsonl are gone, and the CLI keeps no writeRegistry for it', () => {
    expect(ONE_OFF_WRITERS.filter((rel) => existsSync(join(REPO_ROOT, rel)))).toEqual([]);
    expect(readFileSync(join(REPO_ROOT, 'tools/gates/finding-registry.ts'), 'utf8')).not.toMatch(
      /\bfunction\s+writeRegistry\b/,
    );
  });

  it('the sweep lane publishes the event files it writes, under a kernel contract for exactly those paths', () => {
    const frozenFileLines = readFileSync(join(WORKFLOW_DIR, 'finding-state-sweep.yml'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('docs/reviews/_registry/findings.jsonl'));
    expect(frozenFileLines).toEqual([]);
    const contracts = readFileSync(
      join(REPO_ROOT, 'aria-kernel/aria_kernel/workflow_contract_registry.py'),
      'utf8',
    );
    const sweepContract = contracts.slice(
      contracts.indexOf('"finding-state-sweep": WorkflowContract('),
    );
    const allowed = /allowed_write_path_patterns=\(([^)]*)\)/.exec(sweepContract)?.[1] ?? '';
    expect(allowed).toContain(`r"${EVENT_PATH_CONTRACT}"`);
    expect(allowed).not.toContain('findings\\.jsonl');
  });
});
