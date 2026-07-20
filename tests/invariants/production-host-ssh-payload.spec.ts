import { spawnSync } from 'node:child_process';
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
const PAYLOAD_PRODUCER = join(REPO_ROOT, 'tools/scripts/ci/prepare-production-host-ssh-payload.sh');
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root, LC_ALL: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function appendEnvironment(path: string, name: string, value: string): void {
  const encoded = Buffer.from(value).toString('base64');
  writeFileSync(path, `${name}\t${encoded}\n`, { flag: 'a' });
}

describe('production host protected SSH payload', () => {
  it('transports exact-commit control code and preserves env/argv boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-production-host-payload-'));
    try {
      const fixtureProducer = join(
        root,
        'tools/scripts/ci/prepare-production-host-runtime-bundle.sh',
      );
      const fixturePayloadProducer = join(
        root,
        'tools/scripts/ci/prepare-production-host-ssh-payload.sh',
      );
      const fixtureControlPlane = join(root, 'scripts/deploy/production-host-control-plane.sh');
      mkdirSync(dirname(fixtureProducer), { recursive: true });
      mkdirSync(dirname(fixtureControlPlane), { recursive: true });
      copyFileSync(PRODUCER, fixtureProducer);
      copyFileSync(PAYLOAD_PRODUCER, fixturePayloadProducer);
      write(
        fixtureControlPlane,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'runtime_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)',
          'for residue in remote-env.tsv remote-argv.b64 value argument; do',
          '  [ ! -e "${runtime_dir}/${residue}" ] && [ ! -L "${runtime_dir}/${residue}" ] || exit 70',
          'done',
          'case "${1:-}" in lock-exec|shared-exec) ;; *) exit 64 ;; esac',
          'shift',
          '[ "${1:-}" = -- ] || exit 64',
          'shift',
          'exec "$@"',
          '',
        ].join('\n'),
      );
      chmodSync(fixtureProducer, 0o755);
      chmodSync(fixturePayloadProducer, 0o755);
      chmodSync(fixtureControlPlane, 0o755);

      write(
        join(root, 'scripts/deploy/check-service-health.ts'),
        "process.stdout.write('health-runtime\\n');\n",
      );
      write(
        join(root, 'scripts/deploy/assert-service-signals.ts'),
        "process.stdout.write('signals-runtime\\n');\n",
      );
      write(
        join(root, 'scripts/deploy/droplet-capacity.sh'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'printf \'value=%s\\n\' "${DEPLOY_SHA}"',
          'printf \'argument=%s\\n\' "$1"',
          '',
        ].join('\n'),
      );
      chmodSync(join(root, 'scripts/deploy/droplet-capacity.sh'), 0o755);
      write(join(root, 'infrastructure/docker/nats/nats.conf'), 'server_name: fixture\n');
      write(
        join(root, 'apps/example/src/database/migrations/1800000000000-Example.ts'),
        'export class Example1800000000000 {}\n',
      );
      write(join(root, 'apps/db-migrate/src/schema-registry.ts'), 'export const schemas = [];\n');
      write(join(root, '.gitignore'), 'node_modules/\n');

      git(root, ['init', '--quiet']);
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
        'test: payload source',
      ]);
      const sourceSha = git(root, ['rev-parse', 'HEAD']);

      const localNodeModules = join(REPO_ROOT, 'node_modules');
      const workspaceNodeModules = existsSync(join(localNodeModules, 'esbuild/bin/esbuild'))
        ? localNodeModules
        : '/var/aqua-saas/node_modules';
      symlinkSync(workspaceNodeModules, join(root, 'node_modules'));

      const bundle = join(root, 'runtime.tar.gz');
      const produced = spawnSync('/bin/bash', [fixtureProducer], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          LC_ALL: 'C',
          OUTPUT_PATH: bundle,
          SOURCE_SHA: sourceSha,
        },
      });
      expect(produced.status).toBe(0);
      const bundleHash = produced.stdout.trim();
      expect(bundleHash).toMatch(/^[0-9a-f]{64}$/);

      // Dirty worktree bytes must never become the remote authority.
      writeFileSync(
        fixtureControlPlane,
        '#!/usr/bin/env bash\nprintf "DIRTY HELPER EXECUTED\\n" >&2\nexit 99\n',
      );

      const environment = join(root, 'remote-env.tsv');
      const argv = join(root, 'remote-argv.b64');
      const payload = join(root, 'payload.sh');
      writeFileSync(environment, '');
      appendEnvironment(environment, 'DEPLOY_SHA', 'literal $HOME; $(false)');
      writeFileSync(argv, `${Buffer.from('arg; $(false) $HOME').toString('base64')}\n`);

      const payloadBuild = spawnSync('/bin/bash', [fixturePayloadProducer], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          LC_ALL: 'C',
          GIT_DIR: join(root, 'attacker-controlled-git-dir'),
          GIT_OBJECT_DIRECTORY: join(root, 'attacker-controlled-object-dir'),
          PRODUCTION_HOST_BUNDLE_PATH: bundle,
          PRODUCTION_HOST_BUNDLE_SHA256: bundleHash,
          PRODUCTION_HOST_MAIN_SHA: sourceSha,
          PRODUCTION_HOST_REPO_ROOT: root,
          PRODUCTION_HOST_REMOTE_MODE: 'lock-exec',
          PRODUCTION_HOST_REMOTE_ENTRYPOINT: 'scripts/deploy/droplet-capacity.sh',
          PRODUCTION_HOST_REMOTE_ENV_PATH: environment,
          PRODUCTION_HOST_REMOTE_ARGV_PATH: argv,
          SSH_PAYLOAD_PATH: payload,
        },
      });
      expect(payloadBuild.status).toBe(0);
      expect(payloadBuild.stderr).not.toContain('DIRTY HELPER');
      expect(existsSync(payload)).toBe(true);

      const forbiddenEnvironment = join(root, 'forbidden-env.tsv');
      const forbiddenPayload = join(root, 'forbidden-payload.sh');
      writeFileSync(forbiddenEnvironment, '');
      appendEnvironment(forbiddenEnvironment, 'BASH_ENV', '/tmp/attacker');
      const rejectedEnvironment = spawnSync('/bin/bash', [fixturePayloadProducer], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          LC_ALL: 'C',
          PRODUCTION_HOST_BUNDLE_PATH: bundle,
          PRODUCTION_HOST_BUNDLE_SHA256: bundleHash,
          PRODUCTION_HOST_MAIN_SHA: sourceSha,
          PRODUCTION_HOST_REPO_ROOT: root,
          PRODUCTION_HOST_REMOTE_MODE: 'lock-exec',
          PRODUCTION_HOST_REMOTE_ENTRYPOINT: 'scripts/deploy/droplet-capacity.sh',
          PRODUCTION_HOST_REMOTE_ENV_PATH: forbiddenEnvironment,
          PRODUCTION_HOST_REMOTE_ARGV_PATH: argv,
          SSH_PAYLOAD_PATH: forbiddenPayload,
        },
      });
      expect(rejectedEnvironment.status).not.toBe(0);
      expect(rejectedEnvironment.stderr).toContain('remote env name is not approved');
      expect(existsSync(forbiddenPayload)).toBe(false);

      const executed = spawnSync('/bin/bash', [payload], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: root, LC_ALL: 'C' },
      });
      expect(executed.status).toBe(0);
      expect(executed.stdout).toBe('value=literal $HOME; $(false)\nargument=arg; $(false) $HOME\n');
      expect(executed.stderr).not.toContain('DIRTY HELPER');
      expect(readFileSync(payload, 'utf8')).not.toContain('literal $HOME; $(false)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
