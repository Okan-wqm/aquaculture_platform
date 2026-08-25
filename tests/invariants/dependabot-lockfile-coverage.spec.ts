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
  'crates/alarm-core-wasm/Cargo.lock':
    'wasm crate with its own pinned toolchain; bumps are driven by the alarm-core release cadence, not a weekly sweep.',
  'crates/protocol-codec-wasm/Cargo.lock':
    'wasm crate with its own pinned toolchain; same cadence argument as alarm-core-wasm.',
  'sens-api-gateway/Cargo.lock':
    'The edge tree keeps its own deny.toml allowlist and manages its own cadence — stated in the cargo entry of .github/dependabot.yml. RUSTSEC advisories there are handled by cargo-audit + cargo-deny in sens-api-gateway-ci.yml.',
  'sens-api-gateway/fuzz/Cargo.lock':
    'Standalone fuzz harness inside the edge tree; vulnerabilities are enforced by the audit job in sens-api-gateway-ci.yml.',
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
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly steps?: readonly {
          readonly name?: string;
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

  it('audits the standalone edge fuzz lockfile in the required edge gate', () => {
    const workflow = parse(readFileSync(edgeWorkflowPath, 'utf8')) as WorkflowConfig;
    const fuzzAudit = workflow.jobs?.audit?.steps?.find(
      (step) => step.name === 'Audit fuzz lockfile',
    );

    expect(fuzzAudit).toEqual({
      name: 'Audit fuzz lockfile',
      'working-directory': '${{ env.SENS_API_GATEWAY_DIR }}',
      run: 'cargo audit --file fuzz/Cargo.lock',
    });
  });

  it('gives the standalone AquaMobil production lock non-overlapping update ownership', () => {
    const aquamobil = config().updates?.find(
      (update) =>
        update['package-ecosystem'] === 'npm' && update.directory === '/web/apps/aquamobil',
    );

    expect(aquamobil).toMatchObject({
      'package-ecosystem': 'npm',
      directory: '/web/apps/aquamobil',
      'open-pull-requests-limit': 1,
      'versioning-strategy': 'lockfile-only',
      groups: {
        'aquamobil-lock-refresh': {
          'update-types': ['minor', 'patch'],
        },
      },
    });
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
