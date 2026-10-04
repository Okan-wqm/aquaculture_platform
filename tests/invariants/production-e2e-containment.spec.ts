/**
 * Invariant — the production host is not a test bench, and repository-wide
 * application/database secrets never enter a workflow (INFRA-CRITICAL-097,
 * containment half).
 *
 * # WHAT this enforces, over every workflow in `.github/workflows/`
 *
 *   1. No workflow reads `secrets.JWT_SECRET` or `secrets.DB_PASSWORD`. Those
 *      are the platform's token-signing key and its database password; a
 *      workflow that names them hands them to whatever runs in that step.
 *   2. No step that holds the production host credentials (`secrets.DROPLET_*`,
 *      the droplet the production and development lanes deploy to) installs
 *      packages, installs or runs Playwright, runs a `test*` npm script, or
 *      composes a database connection string. The rule holds for every
 *      trigger — `workflow_dispatch`, `workflow_run` after a deploy, push — so
 *      no lane, manual or automatic, can turn the live host into a place where
 *      suites seed rows.
 *   3. No step that holds those credentials copies files off the host through
 *      the third-party `appleboy/scp-action`.
 *
 * A fixture test feeds the detectors the shape that shipped (and a staging
 * lane that must NOT be flagged), so the scan over the real workflows cannot
 * pass vacuously once the offending lane is gone.
 *
 * # WHY
 *
 * `e2e-tests.yml` ran after every production deploy and on manual dispatch,
 * with no stop-line and no exact-release proof. Over the droplet SSH key it ran
 * `npm ci`/`npm install` and `npx playwright install --with-deps` on the live
 * host, exported `DATABASE_URL` built from the repository `DB_PASSWORD`, sent
 * the repository `JWT_SECRET` along, and ran Playwright suites that log in for
 * real and seed rows across the ai/alert/messaging/farm schemas — then pulled
 * the reports back with a third-party SCP action. A green deploy does not make
 * those mutations read-only observation. Staging owning destructive E2E and a
 * read-only, exact-release production smoke are the closure conditions of
 * INFRA-CRITICAL-097; this gate keeps the live-host lane from coming back
 * before then.
 *
 * STAGING_DROPLET_* credentials name a different host and are deliberately
 * outside rule 2: destructive E2E is meant to move there.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const WORKFLOW_DIR = resolve(__dirname, '..', '..', '.github', 'workflows');

/** Repository-wide secrets no workflow may read. */
const FORBIDDEN_SECRETS: ReadonlySet<string> = new Set(['JWT_SECRET', 'DB_PASSWORD']);

/** The production droplet's credentials; `STAGING_DROPLET_*` does not match. */
const PRODUCTION_HOST_SECRET = /^DROPLET_[A-Z0-9_]+$/;

/** npm/pnpm/yarn with any flags (`--prefix e2e`) before the subcommand. */
const PACKAGE_MANAGER = String.raw`\b(?:npm|pnpm|yarn)(?:\s+(?:--\S+|-\w+)(?:[=\s]\S+)?)*\s+`;

const HOST_MUTATIONS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: 'installs packages',
    pattern: new RegExp(`${PACKAGE_MANAGER}(?:ci|install|i|add)\\b`),
  },
  {
    label: 'installs or runs Playwright',
    pattern: /\b(?:npx\s+playwright|playwright\s+(?:install|test))\b/,
  },
  {
    label: 'runs a test script',
    pattern: new RegExp(`${PACKAGE_MANAGER}run\\s+test[\\w:.-]*`),
  },
  {
    label: 'composes a database connection string',
    pattern: /\bpostgres(?:ql)?:\/\//i,
  },
];

const THIRD_PARTY_COPY_ACTION = 'appleboy/scp-action@';

interface WorkflowStep {
  readonly name?: unknown;
  readonly uses?: unknown;
  readonly run?: unknown;
  readonly env?: unknown;
  readonly with?: unknown;
}

interface WorkflowJob {
  readonly env?: unknown;
  readonly steps?: unknown;
}

interface WorkflowDocument {
  readonly env?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
}

interface WorkflowSource {
  readonly file: string;
  readonly document: WorkflowDocument;
}

function liveWorkflows(): WorkflowSource[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({
      file,
      document: yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as WorkflowDocument,
    }));
}

function stepsOf(job: WorkflowJob): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

/**
 * Secret names read inside `${{ ... }}` expressions, in both the dotted and
 * the index form (`secrets.NAME`, `secrets['NAME']`). Only an expression makes
 * the runner resolve a secret, so prose or a path containing the word is not a
 * read.
 */
function secretNames(value: unknown): string[] {
  const names = new Set<string>();
  for (const expression of JSON.stringify(value ?? null).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const body = expression[1] ?? '';
    for (const match of body.matchAll(
      /(?<![A-Za-z0-9_.])secrets(?:\.([A-Za-z0-9_]+)|\[\s*\\?['"]([A-Za-z0-9_]+)\\?['"]\s*\])/g,
    )) {
      const name = match[1] ?? match[2];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
}

function holdsProductionHostCredentials(
  document: WorkflowDocument,
  job: WorkflowJob,
  step: WorkflowStep,
): boolean {
  return [document.env, job.env, step.env, step.with].some((scope) =>
    secretNames(scope).some((name) => PRODUCTION_HOST_SECRET.test(name)),
  );
}

/** Every string a step hands to a shell or an action, shell comments removed. */
function stepProgramText(step: WorkflowStep): string {
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(step.run);
  collect(step.with);
  collect(step.env);
  return strings
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function stepLabel(
  source: WorkflowSource,
  jobId: string,
  step: WorkflowStep,
  index: number,
): string {
  const name = typeof step.name === 'string' ? step.name : `step ${index + 1}`;
  return `${source.file} ${jobId} / ${name}`;
}

function forbiddenSecretReads(sources: readonly WorkflowSource[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    const read = secretNames(source.document).filter((name) => FORBIDDEN_SECRETS.has(name));
    if (read.length > 0) out.push(`${source.file} reads ${read.sort().join(', ')}`);
  }
  return out;
}

function productionHostMutations(sources: readonly WorkflowSource[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const [jobId, job] of Object.entries(source.document.jobs ?? {})) {
      stepsOf(job).forEach((step, index) => {
        if (!holdsProductionHostCredentials(source.document, job, step)) return;
        const program = stepProgramText(step);
        for (const { label, pattern } of HOST_MUTATIONS) {
          if (pattern.test(program)) out.push(`${stepLabel(source, jobId, step, index)} ${label}`);
        }
      });
    }
  }
  return out;
}

function productionHostCopies(sources: readonly WorkflowSource[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const [jobId, job] of Object.entries(source.document.jobs ?? {})) {
      stepsOf(job).forEach((step, index) => {
        if (
          typeof step.uses === 'string' &&
          step.uses.startsWith(THIRD_PARTY_COPY_ACTION) &&
          holdsProductionHostCredentials(source.document, job, step)
        ) {
          out.push(stepLabel(source, jobId, step, index));
        }
      });
    }
  }
  return out;
}

/** The live-host lane as it shipped, reduced to the parts the rules judge. */
const SHIPPED_LIVE_HOST_LANE = [
  'on:',
  '  workflow_dispatch: {}',
  'jobs:',
  '  e2e:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Run E2E tests on server via SSH',
  '        uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2',
  '        env:',
  '          JWT_SECRET: ${{ secrets.JWT_SECRET }}',
  "          DB_PASSWORD: ${{ secrets['DB_PASSWORD'] }}",
  '        with:',
  '          host: ${{ secrets.DROPLET_HOST }}',
  '          key: ${{ secrets.DROPLET_SSH_KEY }}',
  '          script: |',
  '            cd /var/aqua-saas/e2e',
  '            npm ci --prefer-offline --ignore-scripts || npm install --ignore-scripts',
  '            npx playwright install --with-deps chromium',
  '            export DATABASE_URL=postgresql://aquaculture:${DB_PASSWORD}@localhost:5432/aquaculture',
  '            npm --prefix /var/aqua-saas/e2e run test:mobile',
  '      - name: Copy test results from server',
  '        uses: appleboy/scp-action@f9e1f36bc4a2230f8c8e2bac88da0aaa5c32d3dc',
  '        with:',
  '          host: ${{ secrets.DROPLET_HOST }}',
  '          key: ${{ secrets.DROPLET_SSH_KEY }}',
  '          source: /var/aqua-saas/e2e/playwright-report/*',
  '          target: .',
  '',
].join('\n');

/** A staging lane and a runner-local install: neither touches the production host. */
const ALLOWED_LANES = [
  'on:',
  '  workflow_dispatch: {}',
  'jobs:',
  '  staging-e2e:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Install on the runner',
  '        run: npm ci --ignore-scripts --no-audit',
  '      - name: Run E2E on staging',
  '        uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2',
  '        with:',
  '          host: ${{ secrets.STAGING_DROPLET_HOST }}',
  '          key: ${{ secrets.STAGING_DROPLET_SSH_KEY }}',
  '          script: |',
  '            # npm ci on the production host would be flagged; this comment is not',
  '            npx playwright test',
  '',
].join('\n');

function fixture(file: string, text: string): WorkflowSource[] {
  return [{ file, document: yaml.load(text) as WorkflowDocument }];
}

describe('production E2E containment (INFRA-CRITICAL-097)', () => {
  describe('detectors', () => {
    it('flag every part of the live-host lane that shipped', () => {
      const shipped = fixture('shipped.yml', SHIPPED_LIVE_HOST_LANE);

      expect(forbiddenSecretReads(shipped)).toEqual(['shipped.yml reads DB_PASSWORD, JWT_SECRET']);
      expect(productionHostMutations(shipped)).toEqual([
        'shipped.yml e2e / Run E2E tests on server via SSH installs packages',
        'shipped.yml e2e / Run E2E tests on server via SSH installs or runs Playwright',
        'shipped.yml e2e / Run E2E tests on server via SSH runs a test script',
        'shipped.yml e2e / Run E2E tests on server via SSH composes a database connection string',
      ]);
      expect(productionHostCopies(shipped)).toEqual([
        'shipped.yml e2e / Copy test results from server',
      ]);
    });

    it('leave staging lanes, runner-local installs and shell comments alone', () => {
      const allowed = fixture('allowed.yml', ALLOWED_LANES);

      expect(forbiddenSecretReads(allowed)).toEqual([]);
      expect(productionHostMutations(allowed)).toEqual([]);
      expect(productionHostCopies(allowed)).toEqual([]);
    });
  });

  describe('live workflows', () => {
    const sources = liveWorkflows();

    it('read neither the repository JWT secret nor the database password', () => {
      expect(forbiddenSecretReads(sources)).toEqual([]);
    });

    it('never install packages, run suites or reach the database on the production host', () => {
      expect(productionHostMutations(sources)).toEqual([]);
    });

    it('never copy files off the production host through a third-party action', () => {
      expect(productionHostCopies(sources)).toEqual([]);
    });
  });
});
