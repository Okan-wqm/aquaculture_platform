import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runCapacityAutoGcScenario } from './helpers/capacity-gc-harness';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/** Executable shell only: comment prose may describe the old design. */
function executableShell(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

const DEPLOY_SHELL = readdirSync(join(REPO_ROOT, 'scripts/deploy'))
  .filter((name) => name.endsWith('.sh'))
  .map((name) => `scripts/deploy/${name}`)
  .concat(
    readdirSync(join(REPO_ROOT, 'scripts/deploy/lib'))
      .filter((name) => name.endsWith('.sh'))
      .map((name) => `scripts/deploy/lib/${name}`),
  );

const DEPLOY_WORKFLOWS = [
  '.github/workflows/deploy-digitalocean.yml',
  '.github/workflows/deploy-development.yml',
  '.github/workflows/deploy-capacity-maintenance.yml',
  '.github/workflows/production-post-deploy-verify.yml',
];

interface LockPackage {
  dependencies?: Record<string, string>;
  hasInstallScript?: boolean;
}

/**
 * INFRA-HIGH-218 — the production deploy owns its Node dependencies.
 *
 * On 2026-10-10 the development deploy of 1b64b69cb failed at critical_health
 * → rollback_failed: the deploy checkout's node_modules was a symlink to the
 * interactive source repo's node_modules (ORPHAN-HIGH-250), a session's
 * `npm ci` emptied that tree, and every deploy TS gate died with
 * ERR_MODULE_NOT_FOUND js-yaml — including the rollback's.
 *
 * Tier 3 (detectable): these assertions fail at PR time if a deploy surface
 * borrows a session-owned dependency tree again, stops provisioning its own,
 * or imports a package the deploy-owned install would not contain. The
 * install/reuse/retention behavior itself is exercised against a fake npm in
 * tools/gates/deploy-deps.spec.ts.
 */
describe('deploy-owned node_modules (INFRA-HIGH-218)', () => {
  const paths = read('scripts/deploy/deploy-paths.sh');
  const dropletUp = read('scripts/deploy/droplet-up.sh');
  const verify = read('scripts/deploy/post-deploy-verify.sh');
  const capacity = read('scripts/deploy/droplet-capacity.sh');

  it('no deploy script or workflow links or reads the source repo node_modules', () => {
    for (const file of [...DEPLOY_SHELL, ...DEPLOY_WORKFLOWS]) {
      const exec = executableShell(read(file));
      // The ORPHAN-HIGH-250 shape: `ln -sfn "${src}/node_modules" ...`.
      expect({ file, hit: /\bln\b[^\n]*node_modules/u.test(exec) }).toEqual({ file, hit: false });
      expect({ file, hit: /\$\{?(?:src|DEPLOY_SOURCE_REPO)\}?\/node_modules/u.test(exec) }).toEqual(
        { file, hit: false },
      );
      // The literal source-repo tree may appear only as a read-only du
      // diagnostic scope of the capacity report — never as a dependency path.
      if (file !== 'scripts/deploy/droplet-capacity.sh') {
        expect({ file, hit: exec.includes('/var/aqua-saas/node_modules') }).toEqual({
          file,
          hit: false,
        });
      }
    }
    const capacityHits = executableShell(capacity)
      .split('\n')
      .filter((line) => line.includes('/var/aqua-saas/node_modules'));
    for (const line of capacityHits) {
      expect(line.trim()).toMatch(/^\/var\/aqua-saas\/target \/var\/aqua-saas\/node_modules \\$/u);
    }
  });

  it('deploy scripts never source deploy-paths.sh from files in the core.bare source repo', () => {
    for (const file of DEPLOY_SHELL) {
      const exec = executableShell(read(file));
      expect({ file, hit: /source\s+"?\$\{DEPLOY_SOURCE_REPO/u.test(exec) }).toEqual({
        file,
        hit: false,
      });
    }
    expect(executableShell(capacity)).toContain('source "${CAPACITY_SCRIPT_DIR}/deploy-paths.sh"');
  });

  it('declares DEPLOY_DEPS_ROOT once, under the deploy-owned /var/lib/aqua/deploy', () => {
    expect(paths).toContain(
      'export DEPLOY_DEPS_ROOT="${DEPLOY_DEPS_ROOT:-/var/lib/aqua/deploy/deps}"',
    );
    const corpus = [...DEPLOY_SHELL, ...DEPLOY_WORKFLOWS].map(read).join('\n');
    expect(corpus.match(/\/var\/lib\/aqua\/deploy\/deps\b/gu)).toHaveLength(1);
  });

  it('provisions under an exclusive lock and verifies under a shared one', () => {
    const exec = executableShell(paths);
    expect(exec).toContain('provision_deploy_dependencies()');
    expect(exec).toContain('verify_deploy_dependencies()');
    expect(exec).toMatch(
      /flock --exclusive [^\n]*"\$\{DEPLOY_DEPS_ROOT\}\/\.lock" \\\n\s+node "\$\{dir\}\/scripts\/deploy\/deploy-deps\.ts" provision/u,
    );
    expect(exec).toMatch(
      /flock --shared [^\n]*"\$\{DEPLOY_DEPS_ROOT\}\/\.lock" \\\n\s+node "\$\{dir\}\/scripts\/deploy\/deploy-deps\.ts" verify/u,
    );
    // The materializer strips any node_modules that is not deploy-owned.
    expect(exec).toContain('rm -rf "${dir}/node_modules"');
  });

  it('droplet-up provisions after the capacity gate and before any state change or health gate', () => {
    const exec = executableShell(dropletUp);
    const gate = exec.indexOf('bash scripts/deploy/droplet-capacity.sh gate');
    // First provision AFTER the gate (rollback_and_record, defined earlier in
    // the file, re-provisions too).
    const provision = exec.indexOf('if ! provision_deploy_dependencies; then', gate);
    const certs = exec.indexOf('generate-internal-certs.sh');
    const mainHealthGate = exec.lastIndexOf('node scripts/deploy/check-service-health.ts');
    expect(gate).toBeGreaterThan(0);
    expect(provision).toBeGreaterThan(gate);
    expect(certs).toBeGreaterThan(provision);
    expect(mainHealthGate).toBeGreaterThan(provision);
    expect(exec).toContain('record_no_state_changed_failure "deploy_dependencies_unavailable"');
  });

  it('the post-deploy verifier checks (never installs) deps before its health gate', () => {
    const exec = executableShell(verify);
    const check = exec.indexOf('verify_deploy_dependencies >&2');
    const health = exec.indexOf('node scripts/deploy/check-service-health.ts');
    expect(check).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(check);
    expect(exec).not.toContain('provision_deploy_dependencies');
  });

  it('the capacity gate projects the dependency install bytes', () => {
    const exec = executableShell(capacity);
    expect(exec).toContain('projected_deps_bytes()');
    expect(exec).toMatch(/projected_free=\$\(\(avail - pull_estimate - path_deps\)\)/u);
    expect(exec).toContain('deps_projection_unavailable');
  });

  describe('capacity gate projection (behavior, fake df/docker)', () => {
    const base = {
      initialFreeBytes: String(8 * 1024 ** 3),
      reclaimedPerImageBytes: '0',
      projectedPullBytes: '0',
      projectedReserveGib: '1',
    };

    it('passes when the dependency tree is already present', () => {
      const result = runCapacityAutoGcScenario({ ...base, projectedDepsBytes: '0' });
      expect(result.stdout).toContain('Capacity preflight: PASS');
      expect(result.status).toBe(0);
    });

    it('fails when the install would push projected free space below the reserve', () => {
      const result = runCapacityAutoGcScenario({
        ...base,
        projectedDepsBytes: String(7.5 * 1024 ** 3),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('disk_preflight_projected_low');
      expect(result.stdout).toContain(`deps_bytes=${7.5 * 1024 ** 3}`);
    });

    it('fails closed when the projection is unavailable', () => {
      const result = runCapacityAutoGcScenario({ ...base, projectedDepsBytes: 'unavailable' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('deps_projection_unavailable');
    });
  });

  it('deploy scripts load packages only through literal imports, and run only scripts/deploy entrypoints', () => {
    const tsSources = readdirSync(join(REPO_ROOT, 'scripts/deploy'))
      .filter((name) => /\.(?:ts|mts|mjs|js|cjs)$/u.test(name))
      // deploy-deps.ts carries its import probe as a string program; its own
      // imports are pinned to node: builtins by a separate assertion below.
      .filter((name) => name !== 'deploy-deps.ts')
      .map((name) => ({ name, source: read(`scripts/deploy/${name}`) }));
    for (const { name, source } of tsSources) {
      // Import discovery (deploy-deps.ts imports) reads literal specifiers; a
      // computed import or createRequire would escape the install verification.
      expect({ name, dynamic: /\bimport\(\s*[^'"\s)]/u.test(source) }).toEqual({
        name,
        dynamic: false,
      });
      expect({ name, createRequire: /\bcreateRequire\b/u.test(source) }).toEqual({
        name,
        createRequire: false,
      });
    }
    for (const file of DEPLOY_SHELL) {
      const exec = executableShell(read(file));
      for (const match of exec.matchAll(/\bnode[ \t]+(?!-)("?[^\s;|&]+)/gu)) {
        const target = (match[1] ?? '').replace(/^"/u, '').replace(/"$/u, '');
        expect({
          file,
          target,
          // scripts/deploy/<file>, or the capacity script's own directory (which IS
          // scripts/deploy).
          ok: /^(?:\$\{CAPACITY_SCRIPT_DIR\}\/|(?:\S*\/)?scripts\/deploy\/)[\w.-]+\.(?:ts|mjs)$/u.test(
            target,
          ),
        }).toEqual({
          file,
          target,
          ok: true,
        });
      }
      expect({ file, npx: /\bnpx\s/u.test(exec) }).toEqual({ file, npx: false });
    }
  });

  describe('every deploy-script import is installable by the deploy recipe', () => {
    const imports = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/deploy/deploy-deps.ts'),
        'imports',
        '--checkout',
        REPO_ROOT,
        '--root',
        '/nonexistent-deps-root',
      ],
      { encoding: 'utf8' },
    );
    const specifiers = JSON.parse(imports.stdout || '[]') as string[];
    const packageName = (spec: string): string =>
      spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, LockPackage>;
    };

    it('lists the deploy-script imports (js-yaml today)', () => {
      expect(imports.status).toBe(0);
      expect(specifiers).toContain('js-yaml');
    });

    it('each import is a root `dependencies` entry (the install uses --omit=dev)', () => {
      for (const spec of specifiers) {
        expect({ spec, declared: pkg.dependencies?.[packageName(spec)] !== undefined }).toEqual({
          spec,
          declared: true,
        });
      }
    });

    it('no package in their dependency closure needs an install script (the install uses --ignore-scripts)', () => {
      const seen = new Set<string>();
      const queue = specifiers.map(packageName);
      while (queue.length > 0) {
        const name = queue.shift() as string;
        if (seen.has(name)) continue;
        seen.add(name);
        const entry = lock.packages[`node_modules/${name}`];
        expect({ name, inLock: entry !== undefined }).toEqual({ name, inLock: true });
        expect({ name, installScript: entry?.hasInstallScript === true }).toEqual({
          name,
          installScript: false,
        });
        queue.push(...Object.keys(entry?.dependencies ?? {}));
      }
      expect(seen.size).toBeGreaterThan(0);
    });
  });

  it('the install recipe never runs lifecycle scripts or dev dependencies', () => {
    const tool = read('scripts/deploy/deploy-deps.ts');
    expect(tool).toMatch(/const NPM_CI_ARGS[^;]*'ci',\s*'--ignore-scripts',\s*'--omit=dev'/u);
    // Node builtins only: the tool runs before any node_modules exists.
    const bare = [...tool.matchAll(/^import [^;]*? from '([^']+)';/gmu)]
      .map((m) => m[1])
      .filter((spec) => spec !== undefined && !spec.startsWith('node:'));
    expect(bare).toEqual([]);
  });
});
