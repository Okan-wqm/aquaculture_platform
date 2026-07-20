import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PRODUCER = join(REPO_ROOT, 'tools/scripts/ci/prepare-production-host-runtime-bundle.sh');

function spawnUtf8(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { ...options, encoding: 'utf8' });
}

interface BundleFixture {
  readonly root: string;
  readonly sourceSha: string;
  readonly producer: string;
  readonly output: string;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnUtf8('/usr/bin/git', args, {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: root, LC_ALL: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function commit(root: string, message: string): string {
  git(root, ['add', '--all']);
  git(root, [
    '-c',
    'user.name=Aqua Test',
    '-c',
    'user.email=aqua-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(root, ['rev-parse', 'HEAD']);
}

function createFixture(): BundleFixture {
  const root = mkdtempSync(join(tmpdir(), 'aqua-production-host-bundle-'));
  const producer = join(root, 'tools/scripts/ci/prepare-production-host-runtime-bundle.sh');
  mkdirSync(dirname(producer), { recursive: true });
  copyFileSync(PRODUCER, producer);
  chmodSync(producer, 0o755);
  write(
    join(root, 'scripts/deploy/check-service-health.ts'),
    "import { load } from 'js-yaml'; const value = load('value: health-runtime') as { value: string }; process.stdout.write(`${value.value}\\n`);\n",
  );
  write(
    join(root, 'scripts/deploy/assert-service-signals.ts'),
    "const value: string = 'signals-runtime'; process.stdout.write(`${value}\\n`);\n",
  );
  write(join(root, 'infrastructure/docker/nats/nats.conf'), 'server_name: aqua-test\n');
  write(
    join(root, 'apps/example/src/database/migrations/1800000000000-Example.ts'),
    'export class Example1800000000000 {}\n',
  );
  write(join(root, 'apps/db-migrate/src/schema-registry.ts'), 'export const schemas = [];\n');
  write(join(root, 'tracked.txt'), 'protected commit bytes\n');
  write(join(root, '.gitignore'), 'node_modules/\n');

  const localNodeModules = join(REPO_ROOT, 'node_modules');
  const workspaceNodeModules = existsSync(join(localNodeModules, 'esbuild/bin/esbuild'))
    ? localNodeModules
    : '/var/aqua-saas/node_modules';
  if (!existsSync(join(workspaceNodeModules, 'esbuild/bin/esbuild'))) {
    throw new Error('esbuild installation is required for the production-host bundle fixture');
  }
  git(root, ['init', '--quiet']);
  const sourceSha = commit(root, 'test: protected source');
  symlinkSync(workspaceNodeModules, join(root, 'node_modules'));
  return {
    root,
    sourceSha,
    producer,
    output: join(root, 'production-host-runtime.tar.gz'),
  };
}

function runProducer(
  fixture: BundleFixture,
  sourceSha = fixture.sourceSha,
  output = fixture.output,
  producer = fixture.producer,
): SpawnSyncReturns<string> {
  return spawnUtf8('/bin/bash', [producer], {
    cwd: fixture.root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: fixture.root,
      LC_ALL: 'C',
      OUTPUT_PATH: output,
      PRODUCTION_HOST_REPO_ROOT: fixture.root,
      SOURCE_SHA: sourceSha,
    },
  });
}

function archiveFile(bundle: string, path: string): string {
  const result = spawnUtf8('/usr/bin/tar', ['-xOzf', bundle, path]);
  if (result.status !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

describe('production host exact-SHA runtime bundle', () => {
  it('is deterministic and ignores dirty worktree, replacement refs, and mutable Git config', () => {
    const fixture = createFixture();
    try {
      const first = runProducer(fixture);
      expect(first.status).toBe(0);
      expect(first.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
      const firstBytes = readFileSync(fixture.output);
      const firstDigest = createHash('sha256').update(firstBytes).digest('hex');
      expect(first.stdout.trim()).toBe(firstDigest);

      write(join(fixture.root, 'tracked.txt'), 'replacement commit bytes\n');
      const replacementSha = commit(fixture.root, 'test: replacement source');
      git(fixture.root, ['replace', fixture.sourceSha, replacementSha]);
      git(fixture.root, ['config', 'protocol.ext.allow', 'always']);
      git(fixture.root, ['config', 'core.hooksPath', '/tmp/attacker-hooks']);
      git(fixture.root, ['config', 'tar.umask', '0777']);
      write(join(fixture.root, 'tracked.txt'), 'dirty worktree bytes\n');

      const secondOutput = join(fixture.root, 'production-host-runtime-second.tar.gz');
      const second = runProducer(fixture, fixture.sourceSha, secondOutput);
      expect(second.status).toBe(0);
      expect(readFileSync(secondOutput)).toEqual(firstBytes);
      expect(archiveFile(secondOutput, 'repository/tracked.txt')).toBe('protected commit bytes\n');

      const manifest = JSON.parse(archiveFile(secondOutput, 'metadata/manifest.json')) as Record<
        string,
        unknown
      >;
      expect(manifest).toMatchObject({
        format: 'aqua-production-host-runtime-v1',
        main_sha: fixture.sourceSha,
        nats_config_hash: createHash('sha256').update('server_name: aqua-test\n').digest('hex'),
      });
      expect(manifest['tree_hash']).toMatch(/^[0-9a-f]{40,64}$/);
      expect(manifest['first_parent_ancestry_count']).toBe(1);
      expect(manifest['first_parent_ancestry_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(archiveFile(secondOutput, 'metadata/first-parent-ancestry.tsv')).toBe(
        `${fixture.sourceSha}\n`,
      );
      expect(manifest['migration_manifest_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest['check_service_health_runtime_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest['assert_service_signals_runtime_hash']).toMatch(/^[0-9a-f]{64}$/);
      const healthRuntime = archiveFile(secondOutput, 'runtime/check-service-health.mjs');
      expect(healthRuntime).toContain('health-runtime');
      expect(healthRuntime).toContain('// node_modules/js-yaml/');
      expect(healthRuntime).not.toContain('aqua-production-host-bundle-');
      expect(archiveFile(secondOutput, 'runtime/assert-service-signals.mjs')).toContain(
        'signals-runtime',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects tracked symlinks before producing an archive', () => {
    const fixture = createFixture();
    try {
      symlinkSync('/etc/passwd', join(fixture.root, 'unsafe-link'));
      const unsafeSha = commit(fixture.root, 'test: unsafe symlink');
      const result = runProducer(fixture, unsafeSha);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('non-regular tracked entry rejected');
      expect(existsSync(fixture.output)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects tracked gitlinks/submodules before producing an archive', () => {
    const fixture = createFixture();
    try {
      git(fixture.root, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${fixture.sourceSha},unsafe-submodule`,
      ]);
      git(fixture.root, [
        '-c',
        'user.name=Aqua Test',
        '-c',
        'user.email=aqua-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'test: unsafe gitlink',
      ]);
      const unsafeSha = git(fixture.root, ['rev-parse', 'HEAD']);
      const result = runProducer(fixture, unsafeSha);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('non-regular tracked entry rejected');
      expect(existsSync(fixture.output)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('can execute exact producer bytes outside the mutable repository path', () => {
    const fixture = createFixture();
    const exactProducerRoot = mkdtempSync(join(tmpdir(), 'aqua-exact-bundle-producer-'));
    try {
      const exactProducer = join(exactProducerRoot, 'producer.sh');
      copyFileSync(fixture.producer, exactProducer);
      chmodSync(exactProducer, 0o755);

      const result = runProducer(fixture, fixture.sourceSha, fixture.output, exactProducer);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(archiveFile(fixture.output, 'repository/tracked.txt')).toBe(
        'protected commit bytes\n',
      );
    } finally {
      rmSync(exactProducerRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
