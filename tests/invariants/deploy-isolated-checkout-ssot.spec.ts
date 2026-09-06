import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/**
 * Strip shell comments + blank lines so assertions about EXECUTABLE behavior
 * are not satisfied (or false-tripped) by prose in comment blocks.
 */
function executableShell(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Extract the inline `script: |` body of a named ssh-action SSH step from the
 * deploy workflow so we assert against what actually runs on the droplet, not
 * incidental matches elsewhere in the YAML.
 */
function extractSshScriptBlock(workflow: string, stepName: string): string {
  const idx = workflow.indexOf(stepName);
  if (idx < 0) return '';
  const after = workflow.slice(idx);
  const scriptMatch =
    /script: \|\n([\s\S]*?)(?=\n {6}- name:|\n {2}[a-zA-Z0-9_-]+:\n|\n {0,4}\S|$)/.exec(after);
  return scriptMatch?.[1] ?? '';
}

/**
 * SSoT contract for the deploy's isolated, SHA-pinned source checkout.
 *
 * The production deploy must run from a DEDICATED, deploy-owned git worktree
 * (DEPLOY_CHECKOUT_DIR) pinned to the exact deploy SHA — never from the shared,
 * session-mutated /var/aqua-saas interactive working tree. Sharing that tree
 * let the deploy's force-checkout fight live engineering/agent sessions and let
 * post-deploy-verify's `git rev-parse HEAD == TARGET_SHA` guard FALSE-FAIL when
 * a session had drifted HEAD onto a feature branch (real incident:
 * expected=<sha> actual=<feature-branch-sha> with correct images deployed).
 *
 * Tier-3 (detectable): if a future edit re-points the deploy at the shared
 * working tree, or duplicates the checkout-dir constant, this spec fails at PR
 * time.
 */
describe('deploy isolated SHA-pinned checkout SSOT', () => {
  const paths = read('scripts/deploy/deploy-paths.sh');
  const dropletUp = read('scripts/deploy/droplet-up.sh');
  const verify = read('scripts/deploy/post-deploy-verify.sh');
  const workflow = read('.github/workflows/deploy-digitalocean.yml');
  const capacityMaintenance = read('.github/workflows/deploy-capacity-maintenance.yml');

  it('publishes a distinct immutable release and private configuration generation per attempt', () => {
    const exec = executableShell(paths);
    expect(exec).toContain('/var/lib/aqua/deploy/releases');
    expect(exec).toContain('/var/lib/aqua/deploy/config-generations');
    expect(exec).toContain('${sha}/${attempt}');
    expect(exec).toContain('git -C "${src}" worktree add --detach "${source_stage}" "${sha}"');
    expect(exec).not.toContain('checkout -f');
    expect(exec).not.toContain('worktree remove');
    expect(exec).not.toContain('ln -sfn');
    expect(exec).toContain('cp -aL -- "${seed_certs}/." "${configuration_stage}/certs/"');
    expect(exec).toContain(
      'cp --preserve=mode,ownership -- "${seed_env}" "${configuration_stage}/.env"',
    );
    expect(exec).toContain('export COMPOSE_PROJECT_NAME=aqua-saas');
  });

  it('admits compatible healthy infrastructure before publishing source or configuration', () => {
    const exec = executableShell(paths);
    const materializer = exec.slice(exec.indexOf('materialize_deploy_checkout()'));
    expect(materializer.indexOf('assert_deploy_infrastructure')).toBeLessThan(
      materializer.indexOf('worktree add'),
    );
    expect(materializer.indexOf('acquire_deploy_control_lock')).toBeLessThan(
      materializer.indexOf('assert_deploy_infrastructure'),
    );
    expect(exec).toContain('image-contract-mismatch');
    expect(exec).toContain('validate-postgres-dr-state.py');
    expect(exec).toContain('unresolved-recovery');
  });

  it('retains the shared host lock in the executor and binds it to its inode', () => {
    expect(paths).toContain('control-plane.lock');
    expect(paths).toContain('/proc/${BASHPID}/fd/${DEPLOY_CONTROL_LOCK_FD}');
    expect(paths).toContain('flock --exclusive --nonblock');
    expect(paths).toContain('export DEPLOY_CONTROL_LOCK_FD');
  });

  it('runs droplet-up.sh from the isolated checkout, never force-checking-out the shared tree', () => {
    const exec = executableShell(dropletUp);
    // Sources the SSoT snippet from the PERSISTENT source repo (the checkout it
    // creates may not exist yet on first deploy).
    expect(exec).toContain('source "${DEPLOY_SCRIPT_ROOT}/scripts/deploy/deploy-paths.sh"');
    expect(exec).toContain('materialize_deploy_checkout "${DEPLOY_SHA}"');
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');

    // The deploy source must NOT be the interactive working tree anymore.
    expect(exec).not.toMatch(/\bcd\s+\/var\/aqua-saas\b/);
    // No force-checkout of any tree as the deploy-source step (the materializer
    // owns the detached pin via `checkout -f --detach`, which lives in
    // deploy-paths.sh, not here).
    expect(exec).not.toMatch(/git\s+checkout\s+-f\s+\$\{?DEPLOY_SHA/);
    expect(exec).not.toContain('git fetch --force --prune origin\ngit checkout -f');

    // Persistent secrets surface is read from the SSoT vars, not a hardcoded
    // interactive path.
    expect(exec).not.toMatch(/ENV_FILE="\/var\/aqua-saas\/\.env"/);
    expect(exec).not.toMatch(/JWT_KEY_DIR="\/var\/aqua-saas\/certs\/jwt"/);
    expect(exec).toContain('JWT_KEY_DIR="${DEPLOY_CERTS_DIR}/jwt"');
  });

  it('verifies from the isolated checkout so the HEAD == TARGET_SHA guard is a true invariant', () => {
    const exec = executableShell(verify);
    // Piped over SSH via `bash -s` -> source the SSoT from the persistent repo.
    expect(exec).toContain('source "${DEPLOY_SCRIPT_ROOT}/scripts/deploy/deploy-paths.sh"');
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
    expect(exec).not.toMatch(/\bcd\s+\/var\/aqua-saas\b/);
    // The HEAD check remains, now against the deploy-owned worktree.
    expect(exec).toContain('deployed_head="$(git rev-parse HEAD)"');
    expect(exec).toContain('"${deployed_head}" != "${TARGET_SHA}"');
  });

  it('materializes + cd-s into the checkout in BOTH deploy SSH blocks (capacity + deploy), under the 21K limit', () => {
    const capacityBlock = extractSshScriptBlock(
      workflow,
      'Capacity preflight on production droplet',
    );
    const deployBlock = extractSshScriptBlock(workflow, 'Deploy to DigitalOcean Droplet');

    for (const block of [capacityBlock, deployBlock]) {
      expect(block).not.toEqual('');
      const exec = executableShell(block);
      // deploy-paths.sh is read from the DEPLOY_SHA via `git show` (object store,
      // working-tree-independent — ORPHAN-211) then sourced from the extracted copy,
      // so a stale /var/aqua-saas checkout can never break the bootstrap.
      expect(exec).toContain('git show "${DEPLOY_SHA}:scripts/deploy/deploy-paths.sh"');
      expect(exec).toContain('source "${deploy_paths_bootstrap}"');
      expect(exec).toContain('materialize_deploy_checkout "${DEPLOY_SHA}"');
      expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
      // The deploy may `cd /var/aqua-saas` ONLY to fetch objects / `git show` a blob
      // (read-only); it must NEVER checkout or otherwise mutate that shared
      // interactive working tree.
      expect(exec).not.toMatch(/git\s+checkout\b/);
      // GitHub Actions hard-caps a single `${{ }}`/script expression at 21,000
      // chars; the thin-invoker form keeps each SSH block far under it.
      expect(block.length).toBeLessThan(21000);
    }

    // DEPLOY_CHECKOUT_DIR is forwarded into both remote sessions so an operator
    // override propagates from the workflow to the droplet scripts.
    expect(capacityBlock || workflow).toContain('DEPLOY_CHECKOUT_DIR');
    expect(workflow).toContain(
      'envs: DEPLOY_SERVICES,FULL_DEPLOY,DEPLOY_MODE,DEPLOY_SHA,IMAGE_PREFIX,DEPLOY_CHECKOUT_DIR',
    );
  });

  it('runs scheduled capacity maintenance from the same SHA-pinned checkout without mutating the source repo', () => {
    const block = extractSshScriptBlock(
      capacityMaintenance,
      'Run capacity operation through production deploy control plane',
    );
    const exec = executableShell(block);

    expect(block).not.toEqual('');
    expect(exec).toContain('git show "${TARGET_SHA}:scripts/deploy/deploy-paths.sh"');
    expect(exec).toContain('source "${deploy_paths_bootstrap}"');
    expect(exec).toContain('materialize_deploy_checkout "${TARGET_SHA}"');
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
    expect(exec).not.toMatch(/git\s+checkout\b/);
  });

  it('retains both full and selective migration paths while binding rollback to prior config', () => {
    expect(dropletUp).toContain('run_db_migrate_or_exit "full deploy"');
    expect(dropletUp).toContain('run_db_migrate_or_exit "selective deploy"');
    expect(dropletUp).toContain('=== APPLICATION ROLLOUT: ${DEPLOY_SERVICES} ===');
    expect(dropletUp).toContain('migration_boundary_unknown');
    expect(dropletUp).toContain('migration_boundary_crossed');
    expect(dropletUp).toContain('runtime_generation_unproven');
    expect(dropletUp).toContain('incomplete_runtime_snapshot');
    expect(dropletUp).toContain(
      '--env-file "${rollback_config}/.env" -f "${rollback_source}/docker-compose.droplet.yml"',
    );
  });

  it('preserves the rollback + health-gate + public https smoke behavior (untouched by isolation)', () => {
    // Guard against an isolation refactor accidentally deleting the deploy's
    // safety gates. These remain in droplet-up.sh exactly as before.
    expect(dropletUp).toContain('rollback_and_record');
    expect(dropletUp).toContain('check-service-health.ts');
    expect(dropletUp).toContain('Public /graphql smoke through nginx');
    expect(dropletUp).toContain('https://${SMOKE_HOST}');
  });
});

describe('immutable deploy source publication', () => {
  function fixture(): { root: string; repository: string; sha: string } {
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-publication-'));
    const repository = join(root, 'repository');
    mkdirSync(repository);
    for (const args of [
      ['init'],
      ['config', 'user.name', 'Release Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    writeFileSync(join(repository, 'app.txt'), 'first release\n');
    spawnSync('git', ['add', 'app.txt'], { cwd: repository });
    const commit = spawnSync('git', ['commit', '-m', 'fixture'], {
      cwd: repository,
      encoding: 'utf8',
    });
    if (commit.status !== 0) throw new Error(commit.stderr);
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(join(repository, '.env'), 'FIXTURE_VALUE=first\n', { mode: 0o600 });
    mkdirSync(join(repository, 'certs'));
    writeFileSync(join(repository, 'certs', 'fixture.pem'), 'first identity\n');
    return { root, repository, sha };
  }

  function publish(
    root: string,
    repository: string,
    sha: string,
    attempt: string,
    admit = true,
    interruptAt: 'none' | 'add' | 'move' = 'none',
  ): SpawnSyncReturns<string> {
    return spawnSync(
      '/bin/bash',
      [
        '-c',
        `
      set -euo pipefail
      source "$1"
      acquire_deploy_control_lock() { :; }
      assert_deploy_infrastructure() { return ${admit ? 0 : 1}; }
      git() {
        if [ "$3" = worktree ] && [ "$4" = '${interruptAt}' ]; then return 95; fi
        command git "$@"
      }
      materialize_deploy_checkout "$2"
    `,
        '--',
        join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh'),
        sha,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_SOURCE_REPO: repository,
          DEPLOY_RELEASES_ROOT: join(root, 'releases'),
          DEPLOY_CONFIG_ROOT: join(root, 'config'),
          DEPLOY_ENV_FILE: join(repository, '.env'),
          DEPLOY_CERTS_DIR: join(repository, 'certs'),
          DEPLOY_ATTEMPT: attempt,
        },
      },
    );
  }

  it('keeps old source and credential bytes unchanged when another attempt is published', () => {
    const value = fixture();
    try {
      expect(publish(value.root, value.repository, value.sha, '10-1').status).toBe(0);
      writeFileSync(join(value.repository, '.env'), 'FIXTURE_VALUE=second\n');
      writeFileSync(join(value.repository, 'certs', 'fixture.pem'), 'second identity\n');
      expect(publish(value.root, value.repository, value.sha, '11-1').status).toBe(0);
      expect(readFileSync(join(value.root, 'releases', value.sha, '10-1', 'app.txt'), 'utf8')).toBe(
        'first release\n',
      );
      expect(readFileSync(join(value.root, 'config', value.sha, '10-1', '.env'), 'utf8')).toBe(
        'FIXTURE_VALUE=first\n',
      );
      expect(
        readFileSync(join(value.root, 'config', value.sha, '10-1', 'certs', 'fixture.pem'), 'utf8'),
      ).toBe('first identity\n');
      expect(
        readFileSync(join(value.root, 'config', value.sha, '11-1', 'certs', 'fixture.pem'), 'utf8'),
      ).toBe('second identity\n');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each(['add', 'move'] as const)(
    'reenters an interrupted %s publication without replacing the prepared generation',
    (boundary) => {
      const value = fixture();
      try {
        expect(
          publish(value.root, value.repository, value.sha, '10-1', true, boundary).status,
        ).toBe(95);
        expect(existsSync(join(value.root, 'releases', value.sha, '10-1'))).toBe(false);
        writeFileSync(join(value.repository, '.env'), 'FIXTURE_VALUE=changed-after-interruption\n');
        const resumed = publish(value.root, value.repository, value.sha, '10-1');
        expect({ status: resumed.status, stderr: resumed.stderr }).toEqual({
          status: 0,
          stderr: expect.any(String),
        });
        expect(readFileSync(join(value.root, 'config', value.sha, '10-1', '.env'), 'utf8')).toBe(
          'FIXTURE_VALUE=first\n',
        );
        expect(
          readFileSync(join(value.root, 'releases', value.sha, '10-1', 'app.txt'), 'utf8'),
        ).toBe('first release\n');
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('publishes no source or private generation when infrastructure admission rejects the candidate', () => {
    const value = fixture();
    try {
      expect(publish(value.root, value.repository, value.sha, '10-1', false).status).not.toBe(0);
      expect(existsSync(join(value.root, 'releases'))).toBe(false);
      expect(existsSync(join(value.root, 'config'))).toBe(false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
