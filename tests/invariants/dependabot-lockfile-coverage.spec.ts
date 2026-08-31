/**
 * Platform-wide invariant — every dependency lockfile is either watched by
 * Dependabot or carries a written reason why it is not.
 *
 * # Why this exists
 *
 * `.github/dependabot.yml` covered `github-actions` and `cargo` and nothing else.
 * The npm tree — the root lockfile that resolves every member of the `workspaces`
 * globs, and which carries almost all of this repository's open advisories — was
 * the one tree nobody was watching, and had been since the file was written. The
 * gap was invisible: the config looked deliberate, every entry in it was correct,
 * and nothing anywhere compared the set of ecosystems present in the repo against
 * the set being tracked.
 *
 * A missing entry produces no error, no warning and no PR. It looks exactly like
 * an ecosystem with nothing to update. That is the failure mode this test closes:
 * it makes an ecosystem's absence a decision someone had to write down, instead of
 * a silence nobody notices.
 *
 * # What a failure means
 *
 * - **Uncovered lockfile**: a lockfile exists that no `updates` entry reaches.
 *   Either add an entry for its directory, or add it to `DOCUMENTED_EXCLUSIONS`
 *   with the reason — the reason is the point; "not yet" is a valid one, silence
 *   is not.
 * - **Stale exclusion**: a lockfile named in `DOCUMENTED_EXCLUSIONS` is now
 *   covered, or no longer exists. Remove the entry so the list keeps describing
 *   reality.
 *
 * Note the deliberate limit: this test verifies the *config*, not GitHub's side.
 * It cannot see whether Dependabot security updates are enabled for the
 * repository, nor whether the `labels:` these entries reference exist — both live
 * behind the API and neither is checkable offline. Those stay operator
 * responsibilities.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { parse } from 'yaml';

const repoRoot = resolve(__dirname, '../..');
const configPath = resolve(repoRoot, '.github/dependabot.yml');
const edgeWorkflowPath = resolve(repoRoot, '.github/workflows/sens-api-gateway-ci.yml');
const requiredWorkflowPath = resolve(repoRoot, '.github/workflows/ci-affected.yml');
const rustWorkflowPath = resolve(repoRoot, '.github/workflows/rust-ci.yml');
const ignoreSyncPath = resolve(repoRoot, 'scripts/ci/check-advisory-ignore-sync.ts');

/** Lockfile basename → the Dependabot ecosystem that would track it. */
const LOCKFILE_ECOSYSTEM: Readonly<Record<string, string>> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'npm',
  'Cargo.lock': 'cargo',
};

/**
 * Lockfiles knowingly left unwatched, each with the reason. Adding to this list is
 * a decision; leaving a lockfile out of both this list and the config is the
 * defect.
 */
const DOCUMENTED_EXCLUSIONS: Readonly<Record<string, string>> = {
  'sens-api-gateway/Cargo.lock':
    'The edge tree keeps its own deny.toml allowlist and cadence; RUSTSEC advisories are enforced by the required sens-api-gateway-rust audit authority.',
  'sens-api-gateway/fuzz/Cargo.lock':
    'Standalone fuzz harness inside the edge tree; vulnerabilities are enforced by the required sens-api-gateway-rust audit authority.',
};

interface DependabotUpdate {
  readonly 'package-ecosystem': string;
  readonly directory?: string;
  readonly directories?: readonly string[];
  readonly 'open-pull-requests-limit'?: number;
  readonly 'versioning-strategy'?: string;
  readonly groups?: Readonly<
    Record<
      string,
      {
        readonly 'applies-to'?: string;
        readonly 'group-by'?: string;
        readonly patterns?: readonly string[];
        readonly 'update-types'?: readonly string[];
      }
    >
  >;
}

interface DependabotConfig {
  readonly updates?: readonly DependabotUpdate[];
}

interface WorkflowConfig {
  readonly on?: Readonly<Record<'push' | 'pull_request', { readonly paths?: readonly string[] }>>;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly needs?: readonly string[];
        readonly steps?: readonly {
          readonly name?: string;
          readonly uses?: string;
          readonly with?: Record<string, string>;
          readonly 'working-directory'?: string;
          readonly run?: string;
        }[];
      }
    >
  >;
}

function config(): DependabotConfig {
  return parse(readFileSync(configPath, 'utf8')) as DependabotConfig;
}

/** Tracked lockfiles, repo-relative. Uses git so untracked scratch never counts. */
function trackedLockfiles(): string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  const names = Object.keys(LOCKFILE_ECOSYSTEM);
  return tracked
    .split('\n')
    .filter((path) => names.some((name) => path === name || path.endsWith(`/${name}`)))
    .filter((path) => existsSync(resolve(repoRoot, path)))
    .sort();
}

/** Directories the config watches, per ecosystem, normalised to a repo-relative prefix. */
function coveredDirectories(ecosystem: string): string[] {
  const covered: string[] = [];
  for (const update of config().updates ?? []) {
    if (update['package-ecosystem'] !== ecosystem) continue;
    for (const dir of update.directories ?? [update.directory ?? '/']) {
      covered.push(dir.replace(/^\/+/, '').replace(/\/+$/, ''));
    }
  }
  return covered;
}

function lockfileDirectory(lockfile: string): string {
  const slash = lockfile.lastIndexOf('/');
  return slash === -1 ? '' : lockfile.slice(0, slash);
}

/**
 * A root entry (`/`) reaches a workspace member's manifest through the root
 * lockfile, but it does NOT reach a *separate* lockfile in a subdirectory — that
 * file resolves independently. So coverage is an exact directory match.
 */
function isCovered(lockfile: string): boolean {
  const ecosystem = LOCKFILE_ECOSYSTEM[lockfile.split('/').pop() ?? ''];
  if (ecosystem === undefined) return false;
  return coveredDirectories(ecosystem).includes(lockfileDirectory(lockfile));
}

describe('Dependabot lockfile coverage', () => {
  it('keeps npm as the only JavaScript lockfile authority', () => {
    const nonCanonical = trackedLockfiles().filter((lockfile) =>
      lockfile.endsWith('pnpm-lock.yaml'),
    );

    expect(nonCanonical).toEqual([]);
  });

  it('audits every independently resolved Rust lock in the required Sens gate', () => {
    const workflow = parse(readFileSync(requiredWorkflowPath, 'utf8')) as WorkflowConfig;
    const job = workflow.jobs?.['sens-api-gateway-rust'];
    const steps = job?.steps ?? [];

    // The exact pin rotates via dependabot (actions-minor-patch group); the
    // invariant is that the step stays SHA-pinned (never a floating tag) and
    // installs cargo-audit. Repo-wide tag/SHA discipline is enforced by
    // gha-sha-pin-gate.spec.ts.
    expect(steps.find((step) => step.name === 'Install cargo-audit (precompiled)')).toMatchObject({
      uses: expect.stringMatching(/^taiki-e\/install-action@[0-9a-f]{40}$/),
      with: { tool: 'cargo-audit' },
    });
    expect(steps.find((step) => step.name === 'Audit root lockfile')?.run).toBe(
      'cargo audit --deny warnings',
    );
    expect(steps.find((step) => step.name === 'Audit fuzz lockfile')).toMatchObject({
      'working-directory': 'sens-api-gateway',
      run: 'cargo audit --file fuzz/Cargo.lock',
    });
    expect(steps.find((step) => step.name === 'Audit alarm-core WASM lockfile')?.run).toBe(
      'cargo audit --file crates/alarm-core-wasm/Cargo.lock --deny warnings',
    );
    expect(steps.find((step) => step.name === 'Audit protocol-codec WASM lockfile')?.run).toBe(
      'cargo audit --file crates/protocol-codec-wasm/Cargo.lock --deny warnings',
    );

    const summary = workflow.jobs?.['sens-enterprise-summary'];
    expect(summary?.needs).toContain('sens-api-gateway-rust');
    expect(summary?.steps?.map((step) => step.run ?? '').join('\n')).toContain(
      'needs.sens-api-gateway-rust.result',
    );
  });

  it('keeps required edge audit policy aligned with the optional edge workflow', () => {
    const required = parse(readFileSync(requiredWorkflowPath, 'utf8')) as WorkflowConfig;
    const optional = parse(readFileSync(edgeWorkflowPath, 'utf8')) as WorkflowConfig;
    const requiredSteps = required.jobs?.['sens-api-gateway-rust']?.steps ?? [];
    const optionalSteps = optional.jobs?.audit?.steps ?? [];

    for (const name of ['Audit gateway lockfile', 'Audit fuzz lockfile']) {
      const requiredStep = requiredSteps.find((step) => step.name === name);
      const optionalStep = optionalSteps.find((step) => step.name === name);
      expect(requiredStep?.run).toBe(optionalStep?.run);
      expect(requiredStep?.['working-directory']).toBe('sens-api-gateway');
      expect(optionalStep?.['working-directory']).toBe('${{ env.SENS_API_GATEWAY_DIR }}');
    }
  });

  it('reruns advisory lock-step governance when the required edge audit changes', () => {
    const syncSource = readFileSync(ignoreSyncPath, 'utf8');
    const rustWorkflow = parse(readFileSync(rustWorkflowPath, 'utf8')) as WorkflowConfig;

    expect(syncSource).toContain("'.github/workflows/ci-affected.yml'");
    for (const eventName of ['push', 'pull_request'] as const) {
      expect(rustWorkflow.on?.[eventName]?.paths).toContain('.github/workflows/ci-affected.yml');
    }
  });

  it('gives root and AquaMobil one atomic npm update authority', () => {
    const authorities = (config().updates ?? []).filter((update) => {
      if (update['package-ecosystem'] !== 'npm') return false;
      const directories = update.directories ?? [update.directory ?? '/'];
      return directories.some((directory) => ['/', '/web/apps/aquamobil'].includes(directory));
    });

    expect(authorities).toHaveLength(1);
    const authority = authorities[0];
    expect(authority?.directory).toBeUndefined();
    expect(authority?.directories).toEqual(['/', '/web/apps/aquamobil']);
    expect(authority?.['versioning-strategy']).toBe('increase');
    expect(Object.values(authority?.groups ?? {})).toContainEqual({
      'group-by': 'dependency-name',
    });
  });

  it('gives root and production WASM locks one Cargo update authority', () => {
    const cargo = config().updates?.filter((update) => update['package-ecosystem'] === 'cargo');

    expect(cargo).toHaveLength(1);
    expect(cargo?.[0]?.directory).toBeUndefined();
    expect(cargo?.[0]?.directories).toEqual([
      '/',
      '/crates/alarm-core-wasm',
      '/crates/protocol-codec-wasm',
    ]);
  });

  it('watches every lockfile that is not documented as excluded', () => {
    const unaccounted = trackedLockfiles().filter(
      (lockfile) => !isCovered(lockfile) && DOCUMENTED_EXCLUSIONS[lockfile] === undefined,
    );

    expect(unaccounted).toEqual([]);
  });

  it('keeps the exclusion list describing reality', () => {
    const lockfiles = new Set(trackedLockfiles());
    const stale: string[] = [];
    for (const excluded of Object.keys(DOCUMENTED_EXCLUSIONS)) {
      if (!lockfiles.has(excluded)) {
        stale.push(`${excluded}: listed as excluded but no longer exists`);
        continue;
      }
      if (isCovered(excluded)) {
        stale.push(`${excluded}: listed as excluded but the config now covers it`);
      }
    }

    expect(stale).toEqual([]);
  });

  it('gives every exclusion a reason a reader can act on', () => {
    const unreasoned = Object.entries(DOCUMENTED_EXCLUSIONS)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([lockfile]) => lockfile);

    expect(unreasoned).toEqual([]);
  });

  it('still finds the lockfiles it is meant to guard', () => {
    // Guards the guard: if `git ls-files` returns nothing, or the lockfile names
    // change, every assertion above passes while checking nothing.
    const lockfiles = trackedLockfiles();

    expect(lockfiles).toContain('package-lock.json');
    expect(lockfiles).toContain('Cargo.lock');
    expect(lockfiles.length).toBeGreaterThanOrEqual(2);
  });
});
