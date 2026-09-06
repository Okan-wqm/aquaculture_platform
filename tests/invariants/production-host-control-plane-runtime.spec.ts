import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { resolveEsbuildNodeModules } from './_constants';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PRODUCER = join(REPO_ROOT, 'tools/scripts/ci/prepare-production-host-runtime-bundle.sh');
const CONTROL_PLANE = join(REPO_ROOT, 'scripts/deploy/production-host-control-plane.sh');

function spawnUtf8(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { ...options, encoding: 'utf8' });
}

function removeFixtureRoot(root: string): void {
  const fixturePrefix = join(tmpdir(), 'aqua-production-host-control-');
  if (dirname(root) !== tmpdir() || !root.startsWith(fixturePrefix)) {
    throw new Error(`refusing to remove non-canonical production-host fixture root: ${root}`);
  }
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing to remove unsafe production-host fixture root: ${root}`);
  }
  const writable = spawnUtf8('/usr/bin/chmod', ['-R', 'u+rwX', '--', root], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  if (writable.status !== 0) {
    throw new Error(`${writable.stdout}${writable.stderr}`);
  }
  rmSync(root, { recursive: true, force: true });
}

interface RuntimeFixture {
  readonly root: string;
  readonly bundle: string;
  readonly bundleHash: string;
  readonly mainSha: string;
  readonly controlRoot: string;
  readonly containerInspect: string;
  readonly nodeSource: string;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFakeDocker(fixture: RuntimeFixture): string {
  const executable = join(fixture.root, 'fake-docker');
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ps)
    case "\${FAKE_DOCKER_MODE:-valid}" in
      ps-timeout) /usr/bin/sleep 5 ;;
      ps-count)
        for ((index = 0; index < 1025; index += 1)); do
          printf '%064x\n' "\${index}"
        done
        ;;
      ps-no-newline) printf '%s' "\${FAKE_DOCKER_CONTAINER_ID:?}" ;;
      *) printf '%s\n' "\${FAKE_DOCKER_CONTAINER_ID:?}" ;;
    esac
    ;;
  inspect)
    case "\${FAKE_DOCKER_MODE:-valid}" in
      inspect-timeout) /usr/bin/sleep 5 ;;
      inspect-oversize) /usr/bin/head -c 2048 /dev/zero ;;
      *) /usr/bin/cat "\${FAKE_DOCKER_INSPECT_JSON:?}" ;;
    esac
    ;;
  *) printf 'unexpected fake Docker operation: %s\n' "\${1:-missing}" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(executable, 0o755);
  return executable;
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

function createRuntimeFixture(identity = 'runtime'): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'aqua-production-host-control-'));
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
    "process.stdout.write('signals-runtime\\n');\n",
  );
  write(join(root, 'infrastructure/docker/nats/nats.conf'), 'server_name: fixture\n');
  write(
    join(root, 'apps/example/src/database/migrations/1800000000000-Example.ts'),
    'export class Example1800000000000 {}\n',
  );
  write(join(root, 'apps/db-migrate/src/schema-registry.ts'), 'export const schemas = [];\n');
  write(join(root, 'fixture-identity.txt'), `${identity}\n`);
  write(join(root, 'entrypoint.sh'), '#!/usr/bin/env bash\nprintf "entrypoint:%s\\n" "$1"\n');
  chmodSync(join(root, 'entrypoint.sh'), 0o755);
  write(
    join(root, 'scripts/deploy/droplet-up.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${AQUA_DEPLOY_RECOVERY_ONLY:-}" = true ]; then
  printf '%s\n' "\${AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID:?}" > "\${RECOVERY_PROBE:?}"
elif [ "\${AQUA_CONTROL_PLANE_SUPERSESSION_AUTHORIZED:-}" = true ]; then
  printf '%s\t%s\t%s\n' \
    "\${AQUA_DEPLOY_SUPERSEDES_RELEASE_ID:?}" \
    "\${AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA:?}" \
    "\${AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256:?}" > "\${RECOVERY_PROBE:?}"
elif [ "\${AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED:-}" = true ]; then
  printf '%s\t%s\t%s\n' \
    "\${AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA:?}" \
    "\${AQUA_BOOTSTRAP_GC_PREDECESSOR_EPOCH:?}" \
    "\${AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256:?}" > "\${RECOVERY_PROBE:?}"
else
  exit 64
fi
`,
  );
  chmodSync(join(root, 'scripts/deploy/droplet-up.sh'), 0o755);
  write(join(root, '.gitignore'), 'node_modules/\n');
  const workspaceNodeModules = resolveEsbuildNodeModules(REPO_ROOT);
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
    'test: runtime source',
  ]);
  const mainSha = git(root, ['rev-parse', 'HEAD']);
  symlinkSync(workspaceNodeModules, join(root, 'node_modules'));
  const bundle = join(root, 'runtime.tar.gz');
  const produced = spawnUtf8('/bin/bash', [producer], {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      LC_ALL: 'C',
      NODE_BIN: process.execPath,
      OUTPUT_PATH: bundle,
      SOURCE_SHA: mainSha,
    },
  });
  if (produced.status !== 0) {
    throw new Error(`${produced.stdout}${produced.stderr}`);
  }
  const containerInspect = join(root, 'container-inspect.json');
  writeFileSync(containerInspect, '[]\n', { mode: 0o600 });
  chmodSync(containerInspect, 0o600);
  const nodeSource = join(root, 'node-authority');
  writeNodeAuthority(nodeSource, 'v22.7.0', 'fixture-node');
  return {
    root,
    bundle,
    bundleHash: produced.stdout.trim(),
    mainSha,
    controlRoot: join(root, 'control-root'),
    containerInspect,
    nodeSource,
  };
}

function createDescendantFixture(fixture: RuntimeFixture, identity: string): RuntimeFixture {
  write(join(fixture.root, 'fixture-identity.txt'), `${identity}\n`);
  git(fixture.root, ['add', 'fixture-identity.txt']);
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
    `test: ${identity}`,
  ]);
  const mainSha = git(fixture.root, ['rev-parse', 'HEAD']);
  const bundle = join(fixture.root, `${identity}.tar.gz`);
  const producer = join(fixture.root, 'tools/scripts/ci/prepare-production-host-runtime-bundle.sh');
  const produced = spawnUtf8('/bin/bash', [producer], {
    cwd: fixture.root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: fixture.root,
      LC_ALL: 'C',
      NODE_BIN: process.execPath,
      OUTPUT_PATH: bundle,
      SOURCE_SHA: mainSha,
    },
  });
  if (produced.status !== 0) {
    throw new Error(`${produced.stdout}${produced.stderr}`);
  }
  return {
    ...fixture,
    bundle,
    bundleHash: produced.stdout.trim(),
    mainSha,
  };
}

function runtimeEnv(fixture: RuntimeFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: fixture.root,
    LC_ALL: 'C',
    NODE_ENV: 'test',
    AQUA_CONTROL_PLANE_TEST_ROOT: fixture.controlRoot,
    AQUA_CONTROL_PLANE_TEST_NODE_SOURCE: fixture.nodeSource,
    AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: fixture.containerInspect,
    PRODUCTION_HOST_BUNDLE_PATH: fixture.bundle,
    PRODUCTION_HOST_BUNDLE_SHA256: fixture.bundleHash,
    PRODUCTION_HOST_MAIN_SHA: fixture.mainSha,
    ...overrides,
  };
}

function runControl(
  fixture: RuntimeFixture,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnUtf8('/bin/bash', [CONTROL_PLANE, ...args], {
    env: runtimeEnv(fixture, overrides),
  });
}

function terminalJournal(phase: string, mainSha: string): string {
  return `${JSON.stringify({
    candidate: {
      image_digest: `sha256:${'2'.repeat(64)}`,
      main_sha: mainSha,
      repository: 'Okan-wqm/aquaculture_platform',
      run_attempt: '1',
      run_id: '1',
    },
    candidate_image_id: `sha256:${'3'.repeat(64)}`,
    occurred_at: '2026-07-18T00:00:00Z',
    phase,
    prior_image_id: `sha256:${'4'.repeat(64)}`,
    schema_version: 1,
  })}\n`;
}

function writeJournal(fixture: RuntimeFixture, journal: string, unexpected = false): void {
  const runKey = `${fixture.mainSha}-1-1`;
  const stateDirectory = join(fixture.controlRoot, 'dr-bootstrap', runKey);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(fixture.controlRoot, 'dr-bootstrap'), 0o700);
  writeFileSync(join(stateDirectory, 'phase.json'), journal);
  chmodSync(join(stateDirectory, 'phase.json'), 0o400);
  if (unexpected) {
    writeFileSync(join(stateDirectory, '.phase.interrupted'), '{}\n');
    chmodSync(join(stateDirectory, '.phase.interrupted'), 0o400);
  }
}

function writeTerminalJournalArtifacts(
  fixture: RuntimeFixture,
  phase: 'COMMITTED' | 'ROLLED_BACK',
): void {
  const runKey = `${fixture.mainSha}-1-1`;
  const stateDirectory = join(fixture.controlRoot, 'dr-bootstrap', runKey);
  const candidateDigest = `sha256:${'2'.repeat(64)}`;
  const candidateImage = `sha256:${'3'.repeat(64)}`;
  const priorImage = `sha256:${'4'.repeat(64)}`;
  const activeContainer = '5'.repeat(64);
  writeJournal(fixture, terminalJournal(phase, fixture.mainSha));
  const files: Record<string, string> = {
    'postgres-forward.override.yml': 'services:\n  postgres:\n    image: candidate\n',
    'postgres-rollback.override.yml': 'services:\n  postgres:\n    image: prior\n',
    'image-signature.json': `${JSON.stringify([{ critical: { identity: fixture.mainSha } }])}\n`,
    'image-attestations.jsonl': `${JSON.stringify({ payload: 'c2lnbmVk' })}\n`,
    'local-candidate.json': `${JSON.stringify({
      bootstrap: { allowed_compose_services: ['postgres'], channel: 'provider-console' },
      build: { run_attempt: '1', run_id: '1', workflow: 'fixture' },
      image: {
        digest: candidateDigest,
        immutable_tag: `${fixture.mainSha}-1-1`,
        reference: `ghcr.io/okan-wqm/aquaculture_platform/postgres@${candidateDigest}`,
        repository: 'ghcr.io/okan-wqm/aquaculture_platform/postgres',
      },
      materials: [],
      policy: { path: 'fixture', sha256: '6'.repeat(64) },
      postgres_dr_contract_sha256: '7'.repeat(64),
      predicate_type:
        'https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1',
      schema_version: 1,
      source: {
        main_sha: fixture.mainSha,
        ref: 'refs/heads/main',
        repository: 'Okan-wqm/aquaculture_platform',
      },
    })}\n`,
  };
  if (phase === 'COMMITTED') {
    files['result.json'] = `${JSON.stringify({
      active_container_id: activeContainer,
      completed_at: '2026-07-18T00:00:01Z',
      image_digest: candidateDigest,
      image_id: candidateImage,
      main_sha: fixture.mainSha,
      prior_image_id: priorImage,
      result: 'success',
      run_attempt: '1',
      run_id: '1',
    })}\n`;
  } else {
    files['rollback.json'] = `${JSON.stringify({
      active_container_id: activeContainer,
      active_image_id: priorImage,
      candidate_image_id: candidateImage,
      completed_at: '2026-07-18T00:00:01Z',
      prior_image_id: priorImage,
      result: 'rollback',
    })}\n`;
  }
  for (const [name, contents] of Object.entries(files)) {
    const path = join(stateDirectory, name);
    writeFileSync(path, contents, { mode: 0o400 });
    chmodSync(path, 0o400);
  }
}

function runSourcedControl(fixture: RuntimeFixture, body: string): SpawnSyncReturns<string> {
  return spawnUtf8('/bin/bash', ['-c', `source ${JSON.stringify(CONTROL_PLANE)}; ${body}`], {
    env: runtimeEnv(fixture),
  });
}

function writeNodeAuthority(path: string, version: string, marker: string, mode = 0o500): void {
  writeFileSync(
    path,
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then
  printf '%s\\n' ${JSON.stringify(version)}
else
  printf '%s:%s\\n' ${JSON.stringify(marker)} "\${1:-missing}"
fi
`,
    { mode },
  );
  chmodSync(path, mode);
}

describe('production host publisher and common lock runtime', () => {
  it('pins one guarded Node 22 inode and rejects ambient or malformed authorities', () => {
    const fixture = createRuntimeFixture('node-authority');
    const nodeRoot = join(fixture.root, 'node-runtime');
    const nodeSource = join(nodeRoot, 'node');
    const replacement = join(nodeRoot, 'replacement');
    const wrongVersion = join(nodeRoot, 'wrong-version');
    const wrongMode = join(nodeRoot, 'wrong-mode');
    const symlink = join(nodeRoot, 'node-symlink');
    mkdirSync(nodeRoot, { mode: 0o700 });
    chmodSync(nodeRoot, 0o700);
    writeNodeAuthority(nodeSource, 'v22.7.0', 'pinned-node');
    writeNodeAuthority(replacement, 'v21.9.0', 'replacement-node');
    writeNodeAuthority(wrongVersion, 'v21.9.0', 'wrong-version');
    writeNodeAuthority(wrongMode, 'v22.7.0', 'wrong-mode', 0o700);
    symlinkSync(nodeSource, symlink);

    const resolveNode = (
      source: string,
      body = 'aqua_control_plane_resolve_node_authority',
      overrides: NodeJS.ProcessEnv = {},
    ): SpawnSyncReturns<string> =>
      spawnUtf8('/bin/bash', ['-c', `source "$1"; ${body}`, 'node-authority-test', CONTROL_PLANE], {
        env: runtimeEnv(fixture, {
          AQUA_CONTROL_PLANE_TEST_NODE_SOURCE: source,
          ...overrides,
        }),
      });

    try {
      // Supply mutation paths positionally so no fixture path becomes shell syntax.
      const pinnedWithPaths = spawnUtf8(
        '/bin/bash',
        [
          '-c',
          `source "$1"; aqua_control_plane_resolve_node_authority fresh; printf "bin=%s\\n" "$AQUA_PRODUCTION_NODE_BIN"; /usr/bin/mv -f -- "$3" "$2"; exec /bin/bash -c 'source "$1"; aqua_control_plane_require_node_authority; "$AQUA_PRODUCTION_NODE_BIN" runtime.mjs' inherited-node "$1"`,
          'node-authority-test',
          CONTROL_PLANE,
          nodeSource,
          replacement,
        ],
        {
          env: runtimeEnv(fixture, {
            AQUA_CONTROL_PLANE_TEST_NODE_SOURCE: nodeSource,
          }),
        },
      );
      expect(pinnedWithPaths.stderr).toBe('');
      expect(pinnedWithPaths.status).toBe(0);
      expect(pinnedWithPaths.stdout).toMatch(
        /^bin=\/proc\/self\/fd\/[0-9]+\npinned-node:runtime\.mjs\n$/u,
      );
      expect(existsSync(fixture.controlRoot)).toBe(false);

      for (const [source, expected] of [
        [join(nodeRoot, 'missing'), 'source could not be opened'],
        [wrongVersion, 'must be canonical major version 22'],
        [wrongMode, 'source identity is invalid'],
        [symlink, 'source identity is invalid'],
      ] as const) {
        const rejected = resolveNode(source);
        expect(rejected.status).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(expected);
        expect(existsSync(fixture.controlRoot)).toBe(false);
      }

      const rejectedExactDeploy = runControl(
        fixture,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        { AQUA_CONTROL_PLANE_TEST_NODE_SOURCE: wrongVersion },
      );
      expect(rejectedExactDeploy.status).not.toBe(0);
      expect(rejectedExactDeploy.stderr).toContain('must be canonical major version 22');
      expect(existsSync(fixture.controlRoot)).toBe(false);

      const injected = resolveNode(wrongVersion, undefined, {
        AQUA_PRODUCTION_NODE_BIN: '/attacker/node',
      });
      expect(injected.status).not.toBe(0);
      expect(`${injected.stdout}${injected.stderr}`).toContain(
        'Node authority outputs must not be pre-injected',
      );
      expect(existsSync(fixture.controlRoot)).toBe(false);

      const inheritedTuple = (body: string): SpawnSyncReturns<string> =>
        spawnUtf8(
          '/bin/bash',
          [
            '-c',
            `source "$1"; ${body}`,
            'node-inheritance-test',
            CONTROL_PLANE,
            fixture.nodeSource,
          ],
          {
            env: runtimeEnv(fixture),
          },
        );
      const tamperedPath = inheritedTuple(
        'exec {fd}<"$2"; identity=$(/usr/bin/stat -Lc "%u:%a:%h:%d:%i" -- "$2"); export AQUA_PRODUCTION_NODE_FD=$fd AQUA_PRODUCTION_NODE_BIN=/proc/self/fd/999 AQUA_PRODUCTION_NODE_IDENTITY=$identity; aqua_control_plane_resolve_node_authority inherited',
      );
      expect(tamperedPath.status).not.toBe(0);
      expect(tamperedPath.stderr).toContain('authority path is invalid');

      const tamperedIdentity = inheritedTuple(
        'exec {fd}<"$2"; export AQUA_PRODUCTION_NODE_FD=$fd AQUA_PRODUCTION_NODE_BIN=/proc/self/fd/$fd AQUA_PRODUCTION_NODE_IDENTITY=0:500:1:0:0; aqua_control_plane_resolve_node_authority inherited',
      );
      expect(tamperedIdentity.status).not.toBe(0);
      expect(tamperedIdentity.stderr).toContain('authority validation failed');

      const closedDescriptor = inheritedTuple(
        'exec {fd}<"$2"; closed_fd=$fd; identity=$(/usr/bin/stat -Lc "%u:%a:%h:%d:%i" -- "$2"); exec {fd}<&-; export AQUA_PRODUCTION_NODE_FD=$closed_fd AQUA_PRODUCTION_NODE_BIN=/proc/self/fd/$closed_fd AQUA_PRODUCTION_NODE_IDENTITY=$identity; aqua_control_plane_resolve_node_authority inherited',
      );
      expect(closedDescriptor.status).not.toBe(0);
      expect(closedDescriptor.stderr).toContain('authority FD is closed');
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('keeps the GHCR credential out of publisher children and restores only the final child', () => {
    const fixture = createRuntimeFixture();
    const sentinel = 'AQUA_CONTROL_PLANE_GHCR_SENTINEL_081';
    try {
      const result = runControl(
        fixture,
        ['lock-exec', '--', '/bin/bash', '-c', 'builtin printf %s "${GHCR_TOKEN:-missing}"'],
        { GHCR_TOKEN: sentinel },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(sentinel);

      const controlPlane = readFileSync(CONTROL_PLANE, 'utf8');
      const demotionIndex = controlPlane.indexOf('# BEGIN control-plane-ghcr-credential-demotion');
      const firstRuntimeExternalIndex = controlPlane.indexOf('/usr/bin/python3 -');
      const restoreIndex = controlPlane.indexOf(
        'aqua_control_plane_restore_child_ghcr_credential "$@"',
      );
      const execIndex = controlPlane.indexOf('exec "$@"', restoreIndex);
      expect(demotionIndex).toBeGreaterThan(0);
      expect(demotionIndex).toBeLessThan(firstRuntimeExternalIndex);
      expect(controlPlane).toContain('AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL=${GHCR_TOKEN}');
      expect(controlPlane).toContain('unset GHCR_TOKEN');
      expect(restoreIndex).toBeGreaterThan(firstRuntimeExternalIndex);
      expect(execIndex).toBeGreaterThan(restoreIndex);
      expect(
        controlPlane.slice(restoreIndex, execIndex).match(/\/usr\/bin\//gu) ?? [],
      ).toHaveLength(0);
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('publishes atomically, re-verifies existing material, and runs exclusive/shared children', () => {
    const fixture = createRuntimeFixture();
    try {
      writeTerminalJournalArtifacts(fixture, 'COMMITTED');
      const published = runControl(fixture, ['publish']);
      expect(published.status).toBe(0);
      expect(published.stderr).toBe('');
      const repository = published.stdout.trim();
      expect(repository).toBe(`${fixture.controlRoot}/sources/${fixture.mainSha}/repository`);
      expect(readFileSync(join(repository, 'entrypoint.sh'), 'utf8')).toContain('entrypoint:');

      const repeated = runControl(fixture, ['publish']);
      expect(repeated.status).toBe(0);
      expect(repeated.stdout.trim()).toBe(repository);

      const sourceRoot = dirname(repository);
      expect(statSync(sourceRoot).mode & 0o777).toBe(0o555);
      chmodSync(sourceRoot, 0o755);
      const recoveredHandoff = runControl(fixture, ['publish']);
      expect(recoveredHandoff.status).toBe(0);
      expect(recoveredHandoff.stderr).toBe('');
      expect(recoveredHandoff.stdout.trim()).toBe(repository);
      expect(statSync(sourceRoot).mode & 0o777).toBe(0o555);

      const exclusive = runControl(fixture, [
        'lock-exec',
        '--',
        '/bin/bash',
        'entrypoint.sh',
        'exclusive',
      ]);
      expect(exclusive.status).toBe(0);
      expect(exclusive.stdout).toBe('entrypoint:exclusive\n');

      const shared = runControl(fixture, [
        'shared-exec',
        '--',
        '/bin/bash',
        'entrypoint.sh',
        'shared',
      ]);
      expect(shared.status).toBe(0);
      expect(shared.stdout).toBe('entrypoint:shared\n');

      const standaloneHealth = runControl(fixture, [
        'shared-exec',
        '--',
        '/bin/bash',
        '-c',
        'test ! -e node_modules && test -x "$1" && "$1" "$AQUA_CHECK_SERVICE_HEALTH_RUNTIME" > "$HOME/health-output" && /bin/cat "$HOME/health-output"',
        'health-runtime-probe',
        process.execPath,
      ]);
      expect(standaloneHealth.status).toBe(0);
      expect(standaloneHealth.stdout).toBe('health-runtime\n');

      const standaloneSignals = runControl(fixture, [
        'shared-exec',
        '--',
        '/bin/bash',
        '-c',
        'test ! -e node_modules && test -x "$1" && "$1" "$AQUA_ASSERT_SERVICE_SIGNALS_RUNTIME" > "$HOME/signals-output" && /bin/cat "$HOME/signals-output"',
        'signals-runtime-probe',
        process.execPath,
      ]);
      expect(standaloneSignals.status).toBe(0);
      expect(standaloneSignals.stdout).toBe('signals-runtime\n');

      const nested = runControl(fixture, [
        'lock-exec',
        '--',
        '/bin/bash',
        '-c',
        `source ${JSON.stringify(CONTROL_PLANE)}; aqua_control_plane_lock_acquire exclusive 1; aqua_control_plane_lock_assert; printf 'nested-lock-ok\\n'`,
      ]);
      expect(nested.status).toBe(0);
      expect(nested.stdout).toBe('nested-lock-ok\n');
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  /**
   * The lock holder is released by the test, not by a clock.
   *
   * This test used to hold the lock with `sleep 3` and wait up to 10 seconds
   * for the holder to signal. Both numbers are assumptions about machine
   * speed, not about the lock: the holder publishes an exact-SHA source before
   * it ever reaches the marker, so on a loaded runner it can miss a 10-second
   * window, and if it does not, `sleep 3` can still elapse before the second
   * attempt starts — the contended attempt then SUCCEEDS and the assertion
   * that it was refused fails, reporting a lock defect that is not there. A
   * flaky invariant is worse than no invariant, because the next red is read
   * as noise.
   *
   * The handshake removes both races. The holder waits for a release file the
   * test creates, so the lock is provably still held when the second attempt
   * runs, and the wait for the marker is bounded by the test timeout rather
   * than by a guess about how long publication takes.
   */
  it('serializes competing mutations through the fixed inode lock', async () => {
    const fixture = createRuntimeFixture();
    const marker = join(fixture.root, 'lock-held');
    const release = join(fixture.root, 'lock-release');
    let first: ReturnType<typeof spawn> | null = null;
    try {
      first = spawn(
        '/bin/bash',
        [
          CONTROL_PLANE,
          'lock-exec',
          '--',
          '/bin/bash',
          '-c',
          `printf held > ${JSON.stringify(marker)}; ` +
            `while [ ! -e ${JSON.stringify(release)} ]; do /bin/sleep 0.05; done`,
        ],
        { env: runtimeEnv(fixture), stdio: 'pipe' },
      );
      const holder = first;
      let holderExit: number | null = null;
      let holderClosed = false;
      holder.once('close', (code) => {
        holderExit = code;
        holderClosed = true;
      });

      const deadline = Date.now() + 150_000;
      while (!existsSync(marker) && !holderClosed && Date.now() < deadline) {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      expect({ marker: existsSync(marker), holderExit }).toEqual({
        marker: true,
        holderExit: null,
      });

      const second = runControl(fixture, ['lock-exec', '--', '/bin/true'], {
        AQUA_CONTROL_PLANE_LOCK_TIMEOUT_SECONDS: '1',
      });
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain('Timed out acquiring the production control-plane lock');
      // The holder is still holding: nothing but this test can end its wait.
      expect(holderClosed).toBe(false);

      writeFileSync(release, '');
      const firstStatus = await new Promise<number | null>((resolvePromise) => {
        if (holderClosed) {
          resolvePromise(holderExit);
          return;
        }
        holder.once('close', resolvePromise);
      });
      expect(firstStatus).toBe(0);
    } finally {
      if (first !== null && first.exitCode === null && first.signalCode === null) {
        first.kill('SIGKILL');
      }
      removeFixtureRoot(fixture.root);
    }
  }, 300_000);

  it('retains every live bind generation while publishing newer maintenance sources', () => {
    const first = createRuntimeFixture('retention-first');
    const second = createRuntimeFixture('retention-second');
    const retentionRoot = join(first.root, 'retention-root');
    const firstSource = join(retentionRoot, 'sources', first.mainSha);
    const secondSource = join(retentionRoot, 'sources', second.mainSha);
    try {
      expect(
        runControl(first, ['publish'], {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
        }).status,
      ).toBe(0);
      expect(existsSync(firstSource)).toBe(true);

      writeFileSync(
        first.containerInspect,
        `${JSON.stringify([
          {
            Id: 'a'.repeat(64),
            Mounts: [
              {
                Type: 'bind',
                Source: join(firstSource, 'repository', 'entrypoint.sh'),
              },
            ],
          },
        ])}\n`,
        { mode: 0o600 },
      );
      chmodSync(first.containerInspect, 0o600);

      expect(
        runControl(second, ['publish'], {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: first.containerInspect,
        }).status,
      ).toBe(0);
      expect(existsSync(firstSource)).toBe(true);
      expect(existsSync(secondSource)).toBe(true);

      const historical = runControl(first, ['shared-exec', '--', '/bin/true'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
      });
      expect(historical.status).toBe(0);

      writeFileSync(
        second.containerInspect,
        `${JSON.stringify([
          {
            Id: 'b'.repeat(64),
            Mounts: [
              { Type: 'bind', Source: join(firstSource, 'repository') },
              { Type: 'bind', Source: join(secondSource, 'repository', 'entrypoint.sh') },
            ],
          },
        ])}\n`,
        { mode: 0o600 },
      );
      chmodSync(second.containerInspect, 0o600);
      const third = createRuntimeFixture('retention-third');
      const thirdSource = join(retentionRoot, 'sources', third.mainSha);
      const publishedThird = runControl(third, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
        AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: second.containerInspect,
      });
      expect(publishedThird.status).toBe(0);
      expect(existsSync(firstSource)).toBe(true);
      expect(existsSync(secondSource)).toBe(true);
      expect(existsSync(thirdSource)).toBe(true);
      removeFixtureRoot(third.root);

      const corruptObsolete = join(firstSource, 'repository', 'entrypoint.sh');
      chmodSync(corruptObsolete, 0o644);
      writeFileSync(corruptObsolete, '#!/bin/false\n');
      chmodSync(corruptObsolete, 0o555);
      const guardedRetention = runControl(second, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
        AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: first.containerInspect,
      });
      expect(guardedRetention.status).not.toBe(0);
      expect(guardedRetention.stderr).toContain('tracked file hash mismatch');
      expect(existsSync(firstSource)).toBe(true);
      expect(existsSync(secondSource)).toBe(true);
    } finally {
      removeFixtureRoot(first.root);
      removeFixtureRoot(second.root);
    }
  });

  it('retains the marker-authoritative source even when no container bind exposes it', () => {
    const first = createRuntimeFixture('marker-retention-first');
    const second = createRuntimeFixture('marker-retention-second');
    const retentionRoot = join(first.root, 'marker-retention-root');
    const firstSource = join(retentionRoot, 'sources', first.mainSha);
    const secondSource = join(retentionRoot, 'sources', second.mainSha);
    const releaseId = `${first.mainSha}-20260719T010203Z`;
    const releaseDirectory = join(retentionRoot, 'releases', releaseId);
    const manifest = Buffer.from(
      `gateway-api\tghcr.io/okan-wqm/aquaculture_platform/gateway-api\tsha256:${'8'.repeat(64)}\n`,
    );
    const manifestHash = createHash('sha256').update(manifest).digest('hex');
    try {
      expect(
        runControl(first, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      const metadataRoot = join(firstSource, 'metadata');
      const sourceManifestPath = join(metadataRoot, 'manifest.json');
      const sourceManifest: unknown = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
      if (
        typeof sourceManifest !== 'object' ||
        sourceManifest === null ||
        Array.isArray(sourceManifest)
      ) {
        throw new Error('fixture source manifest is not an object');
      }
      const legacyManifest = Object.fromEntries(
        Object.entries(sourceManifest).filter(
          ([key]) => key !== 'first_parent_ancestry_count' && key !== 'first_parent_ancestry_hash',
        ),
      );
      chmodSync(metadataRoot, 0o755);
      chmodSync(sourceManifestPath, 0o644);
      rmSync(join(metadataRoot, 'first-parent-ancestry.tsv'));
      writeFileSync(sourceManifestPath, `${JSON.stringify(legacyManifest)}\n`);
      chmodSync(sourceManifestPath, 0o444);
      chmodSync(metadataRoot, 0o555);
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      chmodSync(join(retentionRoot, 'releases'), 0o700);
      writeFileSync(join(releaseDirectory, 'image-digests.tsv'), manifest, { mode: 0o600 });
      writeFileSync(
        join(retentionRoot, 'current-release.json'),
        `${JSON.stringify({
          image_digest_manifest_sha256: manifestHash,
          main_sha: first.mainSha,
          promoted_at: '2026-07-19T01:02:03Z',
          release_id: releaseId,
          schema_version: 1,
        })}\n`,
        { mode: 0o400 },
      );
      chmodSync(join(retentionRoot, 'current-release.json'), 0o400);

      const published = runControl(second, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
      });
      expect(published.status).toBe(0);
      expect(published.stderr).toBe('');
      expect(existsSync(firstSource)).toBe(true);
      expect(existsSync(secondSource)).toBe(true);
    } finally {
      removeFixtureRoot(first.root);
      removeFixtureRoot(second.root);
    }
  });

  it('accepts a real materialized and sealed release in the authoritative retention reader', () => {
    const fixture = createRuntimeFixture('materialized-release-retention');
    const repository = join(fixture.root, 'publication-repository');
    const releases = join(fixture.controlRoot, 'releases');
    const configuration = join(fixture.controlRoot, 'config-generations');
    mkdirSync(repository, { mode: 0o700 });
    git(repository, ['init']);
    git(repository, ['config', 'user.name', 'Release Fixture']);
    git(repository, ['config', 'user.email', 'fixture@example.invalid']);
    git(repository, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repository, 'fixture.txt'), 'immutable release');
    git(repository, ['add', 'fixture.txt']);
    git(repository, ['commit', '-m', 'fixture']);
    const sha = git(repository, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repository, '.env'), 'FIXTURE_VALUE=private\n', { mode: 0o600 });
    mkdirSync(join(repository, 'certs'), { mode: 0o700 });
    writeFileSync(join(repository, 'certs', 'fixture.pem'), 'fixture identity');
    try {
      expect(runControl(fixture, ['publish']).status).toBe(0);
      const published = spawnUtf8(
        '/bin/bash',
        [
          '-c',
          `
        set -euo pipefail
        source "$1"
        acquire_deploy_control_lock() { :; }
        assert_deploy_infrastructure() { :; }
        materialize_deploy_checkout "$2"
        seal_deploy_configuration
      `,
          '--',
          join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh'),
          sha,
        ],
        {
          env: {
            ...runtimeEnv(fixture),
            DEPLOY_SOURCE_REPO: repository,
            DEPLOY_RELEASES_ROOT: releases,
            DEPLOY_CONFIG_ROOT: configuration,
            DEPLOY_ENV_FILE: join(repository, '.env'),
            DEPLOY_CERTS_DIR: join(repository, 'certs'),
            DEPLOY_ATTEMPT: '10-1',
          },
        },
      );
      expect({ status: published.status, stderr: published.stderr }).toEqual({
        status: 0,
        stderr: expect.any(String),
      });
      expect(statSync(join(releases, sha, '10-1')).mode & 0o777).toBe(0o555);
      const retained = runSourcedControl(
        fixture,
        'aqua_control_plane_lock_acquire exclusive 1; aqua_control_plane_prune_releases',
      );
      expect({ status: retained.status, stderr: retained.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(readFileSync(join(releases, sha, '10-1', 'fixture.txt'), 'utf8')).toBe(
        'immutable release',
      );
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('prunes release state to a bounded audit window while preserving every live reference', () => {
    const fixture = createRuntimeFixture('release-retention');
    const retentionRoot = join(fixture.root, 'release-retention-root');
    const releasesRoot = join(retentionRoot, 'releases');
    const releaseIds: string[] = [];
    const prune = (): SpawnSyncReturns<string> =>
      spawnUtf8(
        '/bin/bash',
        [
          '-c',
          `source "${CONTROL_PLANE}"; aqua_control_plane_lock_acquire exclusive 1; aqua_control_plane_prune_releases`,
        ],
        { env: runtimeEnv(fixture, { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }) },
      );
    try {
      expect(
        runControl(fixture, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      mkdirSync(releasesRoot, { mode: 0o755 });
      for (let index = 0; index < 70; index += 1) {
        const sha = index.toString(16).padStart(40, '0');
        const hour = Math.floor(index / 60);
        const minute = index % 60;
        const releaseId = `${sha}-20260719T${String(hour).padStart(2, '0')}${String(
          minute,
        ).padStart(2, '0')}00Z`;
        releaseIds.push(releaseId);
        mkdirSync(join(releasesRoot, releaseId), { mode: 0o700 });
      }
      const [
        currentReleaseId,
        candidateReleaseId,
        priorReleaseId,
        supersededReleaseId,
        fifthId,
        sixthId,
      ] = releaseIds;
      if (
        currentReleaseId === undefined ||
        candidateReleaseId === undefined ||
        priorReleaseId === undefined ||
        supersededReleaseId === undefined ||
        fifthId === undefined ||
        sixthId === undefined
      ) {
        throw new Error('release retention fixture did not create its required release inventory');
      }
      const markerManifest = 'marker\n';
      writeFileSync(join(releasesRoot, currentReleaseId, 'image-digests.tsv'), markerManifest, {
        mode: 0o600,
      });
      writeFileSync(
        join(retentionRoot, 'current-release.json'),
        `${JSON.stringify({
          image_digest_manifest_sha256: createHash('sha256').update(markerManifest).digest('hex'),
          main_sha: currentReleaseId.slice(0, 40),
          promoted_at: '2026-07-19T00:00:00Z',
          release_id: currentReleaseId,
          schema_version: 1,
        })}\n`,
        { mode: 0o400 },
      );
      const priorManifestHash = '7'.repeat(64);
      writeFileSync(
        join(retentionRoot, 'active-release-transaction.json'),
        `${JSON.stringify({
          candidate_sha: candidateReleaseId.slice(0, 40),
          deploy_services: ['db-migrate'],
          failure_phase: 'migration_boundary_crossed',
          full_deploy: false,
          image_digest_manifest_sha256: '5'.repeat(64),
          migrations_applied: 1,
          occurred_at: '2026-07-19T00:00:01Z',
          phase: 'FORWARD_REQUIRED',
          prior_release: {
            image_digest_manifest_sha256: priorManifestHash,
            main_sha: priorReleaseId.slice(0, 40),
            promoted_at: '2026-07-19T00:00:00Z',
            release_id: priorReleaseId,
            schema_version: 1,
          },
          release_id: candidateReleaseId,
          rollback_manifest_sha256: '6'.repeat(64),
          rollback_policy: 'FORWARD_ONLY',
          schema_version: 2,
          supersedes_candidate_sha: supersededReleaseId.slice(0, 40),
          supersedes_release_id: supersededReleaseId,
          supersession_proof_sha256: '8'.repeat(64),
        })}\n`,
        { mode: 0o400 },
      );
      chmodSync(join(retentionRoot, 'current-release.json'), 0o400);
      chmodSync(join(retentionRoot, 'active-release-transaction.json'), 0o400);

      const retiringId = `${'f'.repeat(40)}-20260718T235959Z`;
      const retiringRoot = join(releasesRoot, `.retiring.${retiringId}`);
      mkdirSync(join(retiringRoot, 'rollback-state'), { recursive: true, mode: 0o700 });
      writeFileSync(join(retiringRoot, 'rollback-state', 'rollback-images.tsv'), '', {
        mode: 0o600,
      });
      const retained = prune();
      expect(retained.status).toBe(0);
      expect(statSync(releasesRoot).mode & 0o777).toBe(0o700);
      expect(existsSync(retiringRoot)).toBe(false);
      for (const protectedId of releaseIds.slice(0, 4)) {
        expect(existsSync(join(releasesRoot, protectedId))).toBe(true);
      }
      expect(existsSync(join(releasesRoot, fifthId))).toBe(false);
      expect(existsSync(join(releasesRoot, sixthId))).toBe(false);
      expect(readdirSync(releasesRoot)).toHaveLength(68);
      expect(prune().status).toBe(0);

      const safeOldId = `${'a'.repeat(40)}-20260717T000000Z`;
      const hostileOldId = `${'b'.repeat(40)}-20260717T000001Z`;
      mkdirSync(join(releasesRoot, safeOldId), { mode: 0o700 });
      mkdirSync(join(releasesRoot, hostileOldId), { mode: 0o700 });
      symlinkSync('/etc/passwd', join(releasesRoot, hostileOldId, 'hostile'));
      const rejected = prune();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('release retention entry is unsafe');
      expect(existsSync(join(releasesRoot, safeOldId))).toBe(true);
      expect(existsSync(join(releasesRoot, hostileOldId))).toBe(true);
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('fails before every retention mutation on a corrupt journal or N+1 release inventory', () => {
    const controlPlane = readFileSync(CONTROL_PLANE, 'utf8');
    expect(controlPlane).toContain('with os.scandir(releases) as release_stream:');
    expect(controlPlane).not.toContain('list(releases.iterdir())');
    const fixture = createRuntimeFixture('release-retention-bounds');
    const retentionRoot = join(fixture.root, 'release-retention-bounds-root');
    const releasesRoot = join(retentionRoot, 'releases');
    const releaseIds: string[] = [];
    const prune = (): SpawnSyncReturns<string> =>
      spawnUtf8(
        '/bin/bash',
        [
          '-c',
          `source "${CONTROL_PLANE}"; aqua_control_plane_lock_acquire exclusive 1; aqua_control_plane_prune_releases`,
        ],
        { env: runtimeEnv(fixture, { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }) },
      );
    try {
      expect(
        runControl(fixture, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      mkdirSync(releasesRoot, { mode: 0o700 });
      for (let index = 0; index < 70; index += 1) {
        const sha = index.toString(16).padStart(40, '0');
        const releaseId = `${sha}-20260719T000000Z`;
        releaseIds.push(releaseId);
        mkdirSync(join(releasesRoot, releaseId), { mode: 0o700 });
      }
      const currentReleaseId = releaseIds[0];
      if (currentReleaseId === undefined) {
        throw new Error('bounded release fixture did not create its current release');
      }
      const markerManifest = 'bounded-marker\n';
      writeFileSync(join(releasesRoot, currentReleaseId, 'image-digests.tsv'), markerManifest, {
        mode: 0o600,
      });
      writeFileSync(
        join(retentionRoot, 'current-release.json'),
        `${JSON.stringify({
          image_digest_manifest_sha256: createHash('sha256').update(markerManifest).digest('hex'),
          main_sha: currentReleaseId.slice(0, 40),
          promoted_at: '2026-07-19T00:00:00Z',
          release_id: currentReleaseId,
          schema_version: 1,
        })}\n`,
        { mode: 0o400 },
      );
      const journalPath = join(retentionRoot, 'active-release-transaction.json');
      writeFileSync(journalPath, '{"corrupt":true}\n', { mode: 0o400 });
      const beforeCorruptJournal = readdirSync(releasesRoot).sort();
      const corruptJournal = prune();
      expect(corruptJournal.status).not.toBe(0);
      expect(corruptJournal.stderr).toContain('release retention journal schema is invalid');
      expect(readdirSync(releasesRoot).sort()).toEqual(beforeCorruptJournal);

      rmSync(journalPath);
      for (let index = releaseIds.length; index < 2049; index += 1) {
        const sha = index.toString(16).padStart(40, '0');
        const releaseId = `${sha}-20260719T000000Z`;
        releaseIds.push(releaseId);
        mkdirSync(join(releasesRoot, releaseId), { mode: 0o700 });
      }
      const beforeOverflow = readdirSync(releasesRoot).sort();
      expect(beforeOverflow).toHaveLength(2049);
      const overflow = prune();
      expect(overflow.status).not.toBe(0);
      expect(overflow.stderr).toContain('release retention inventory is unbounded');
      expect(readdirSync(releasesRoot).sort()).toEqual(beforeOverflow);
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('blocks new host operations behind an unresolved release transaction journal', () => {
    const first = createRuntimeFixture('transaction-guard-first');
    const second = createRuntimeFixture('transaction-guard-second');
    const retentionRoot = join(first.root, 'transaction-guard-root');
    const journalPath = join(retentionRoot, 'active-release-transaction.json');
    const recoveryProbe = join(first.root, 'recovery-owner');
    const releaseId = `${first.mainSha}-20260719T010203Z`;
    const journal = (phase: 'PREPARED' | 'ROLLED_BACK'): string =>
      `${JSON.stringify({
        candidate_sha: first.mainSha,
        deploy_services: ['db-migrate'],
        failure_phase: null,
        full_deploy: false,
        image_digest_manifest_sha256: '5'.repeat(64),
        migrations_applied: null,
        occurred_at: '2026-07-19T01:02:03Z',
        phase,
        prior_release: null,
        release_id: releaseId,
        rollback_manifest_sha256: '6'.repeat(64),
        schema_version: 1,
      })}\n`;
    try {
      expect(
        runControl(first, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      writeFileSync(journalPath, journal('PREPARED'), { mode: 0o400 });
      chmodSync(journalPath, 0o400);
      const blocked = runControl(second, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
      });
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain('is unresolved at phase PREPARED');
      expect(existsSync(join(retentionRoot, 'sources', first.mainSha))).toBe(true);
      expect(existsSync(join(retentionRoot, 'sources', second.mainSha))).toBe(false);

      const wrongNodeSource = join(first.root, 'wrong-deploy-node');
      writeNodeAuthority(wrongNodeSource, 'v21.9.0', 'wrong-deploy-node');
      const journalBeforeRejectedDeploy = readFileSync(journalPath, 'utf8');
      const rejectedDeploy = runControl(
        first,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          AQUA_CONTROL_PLANE_TEST_NODE_SOURCE: wrongNodeSource,
          RECOVERY_PROBE: recoveryProbe,
        },
      );
      expect(rejectedDeploy.status).not.toBe(0);
      expect(rejectedDeploy.stderr).toContain('must be canonical major version 22');
      expect(readFileSync(journalPath, 'utf8')).toBe(journalBeforeRejectedDeploy);
      expect(existsSync(recoveryProbe)).toBe(false);
      expect(existsSync(join(retentionRoot, 'sources', second.mainSha))).toBe(false);

      const recovery = runControl(
        first,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          RECOVERY_PROBE: recoveryProbe,
        },
      );
      expect(recovery.status).toBe(0);
      expect(readFileSync(recoveryProbe, 'utf8')).toBe(`${releaseId}\n`);
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
        rollback_policy: 'ALLOW_ZERO_MIGRATION',
        schema_version: 2,
        supersedes_candidate_sha: null,
        supersedes_release_id: null,
        supersession_proof_sha256: null,
      });

      chmodSync(journalPath, 0o600);
      writeFileSync(journalPath, journal('ROLLED_BACK'));
      chmodSync(journalPath, 0o400);
      const resumed = runControl(second, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
      });
      expect(resumed.status).toBe(0);
    } finally {
      removeFixtureRoot(first.root);
      removeFixtureRoot(second.root);
    }
  });

  it('authorizes only a bounded first-parent descendant to supersede FORWARD_REQUIRED', () => {
    const base = createRuntimeFixture('forward-required-base');
    const descendant = createDescendantFixture(base, 'forward-required-descendant');
    const unrelated = createRuntimeFixture('forward-required-unrelated');
    const retentionRoot = join(base.root, 'forward-required-root');
    const releaseId = `${base.mainSha}-20260719T020304Z`;
    const probe = join(base.root, 'forward-required-probe');
    const journal = `${JSON.stringify({
      candidate_sha: base.mainSha,
      deploy_services: ['db-migrate'],
      failure_phase: 'migration_boundary_crossed',
      full_deploy: false,
      image_digest_manifest_sha256: '5'.repeat(64),
      migrations_applied: 1,
      occurred_at: '2026-07-19T02:03:04Z',
      phase: 'FORWARD_REQUIRED',
      prior_release: null,
      release_id: releaseId,
      rollback_manifest_sha256: '6'.repeat(64),
      rollback_policy: 'ALLOW_ZERO_MIGRATION',
      schema_version: 2,
      supersedes_candidate_sha: null,
      supersedes_release_id: null,
      supersession_proof_sha256: null,
    })}\n`;
    try {
      expect(
        runControl(base, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      const journalPath = join(retentionRoot, 'active-release-transaction.json');
      writeFileSync(journalPath, journal, { mode: 0o400 });
      chmodSync(journalPath, 0o400);

      const rejected = runControl(
        unrelated,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          RECOVERY_PROBE: probe,
        },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'candidate is not a bounded first-parent descendant of the predecessor',
      );
      expect(existsSync(probe)).toBe(false);

      const accepted = runControl(
        descendant,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          RECOVERY_PROBE: probe,
        },
      );
      expect(accepted.status).toBe(0);
      const [recordedRelease, recordedSha, proofHash] = readFileSync(probe, 'utf8')
        .trim()
        .split('\t');
      expect(recordedRelease).toBe(releaseId);
      expect(recordedSha).toBe(base.mainSha);
      const ancestry = readFileSync(
        join(retentionRoot, 'sources', descendant.mainSha, 'metadata/first-parent-ancestry.tsv'),
      );
      expect(proofHash).toBe(createHash('sha256').update(ancestry).digest('hex'));
      expect(existsSync(join(retentionRoot, 'sources', base.mainSha))).toBe(true);
      expect(existsSync(join(retentionRoot, 'sources', descendant.mainSha))).toBe(true);
    } finally {
      removeFixtureRoot(base.root);
      removeFixtureRoot(unrelated.root);
    }
  });

  it('exports markerless bootstrap rollover authority only for an authenticated descendant', () => {
    const base = createRuntimeFixture('bootstrap-rollover-base');
    const descendant = createDescendantFixture(base, 'bootstrap-rollover-descendant');
    const unrelated = createRuntimeFixture('bootstrap-rollover-unrelated');
    const retentionRoot = join(base.root, 'bootstrap-rollover-root');
    const probe = join(base.root, 'bootstrap-rollover-probe');
    try {
      expect(
        runControl(base, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      writeFileSync(
        join(retentionRoot, 'bootstrap-image-gc.json'),
        `${JSON.stringify({
          claimed_at: '2026-07-19T01:00:00Z',
          completed_at: '2026-07-19T01:01:00Z',
          epoch: 1,
          incoming_sha: base.mainSha,
          predecessor_sha: null,
          schema_version: 2,
          state: 'COMPLETED',
          supersession_proof_sha256: null,
        })}\n`,
        { mode: 0o400 },
      );
      chmodSync(join(retentionRoot, 'bootstrap-image-gc.json'), 0o400);

      const rejected = runControl(
        unrelated,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          RECOVERY_PROBE: probe,
        },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'candidate is not a bounded first-parent descendant of the predecessor',
      );
      expect(existsSync(probe)).toBe(false);

      const accepted = runControl(
        descendant,
        ['lock-exec', '--', '/bin/bash', 'scripts/deploy/droplet-up.sh'],
        {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          RECOVERY_PROBE: probe,
        },
      );
      expect(accepted.status).toBe(0);
      const [predecessor, epoch, proofHash] = readFileSync(probe, 'utf8').trim().split('\t');
      expect(predecessor).toBe(base.mainSha);
      expect(epoch).toBe('1');
      const ancestry = readFileSync(
        join(retentionRoot, 'sources', descendant.mainSha, 'metadata/first-parent-ancestry.tsv'),
      );
      expect(proofHash).toBe(createHash('sha256').update(ancestry).digest('hex'));
    } finally {
      removeFixtureRoot(base.root);
      removeFixtureRoot(unrelated.root);
    }
  });

  it('fails closed on hostile or non-canonical container bind inventories before pruning', () => {
    const first = createRuntimeFixture('hostile-retention-first');
    const second = createRuntimeFixture('hostile-retention-second');
    const retentionRoot = join(first.root, 'hostile-retention-root');
    const firstSource = join(retentionRoot, 'sources', first.mainSha);
    const secondSource = join(retentionRoot, 'sources', second.mainSha);
    try {
      expect(
        runControl(first, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      for (const source of [
        join(retentionRoot, 'sources', '.source.attacker', 'repository'),
        `${join(firstSource, 'repository')}/../repository`,
        `${join(firstSource, 'repository')}//entrypoint.sh`,
      ]) {
        writeFileSync(
          first.containerInspect,
          `${JSON.stringify([
            { Id: 'c'.repeat(64), Mounts: [{ Type: 'bind', Source: source }] },
          ])}\n`,
          { mode: 0o600 },
        );
        chmodSync(first.containerInspect, 0o600);
        const result = runControl(second, ['publish'], {
          AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
          AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: first.containerInspect,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Docker bind source inventory failed closed');
        expect(existsSync(firstSource)).toBe(true);
        expect(existsSync(secondSource)).toBe(true);
      }
    } finally {
      removeFixtureRoot(first.root);
      removeFixtureRoot(second.root);
    }
  });

  it('bounds the production Docker inventory producer by bytes, time, and container count', () => {
    const first = createRuntimeFixture('bounded-docker-first');
    const second = createRuntimeFixture('bounded-docker-second');
    const retentionRoot = join(first.root, 'bounded-docker-retention');
    const firstSource = join(retentionRoot, 'sources', first.mainSha);
    const secondSource = join(retentionRoot, 'sources', second.mainSha);
    const containerId = 'd'.repeat(64);
    try {
      expect(
        runControl(first, ['publish'], { AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot }).status,
      ).toBe(0);
      writeFileSync(
        first.containerInspect,
        `${JSON.stringify([
          {
            Id: containerId,
            Mounts: [{ Type: 'bind', Source: join(firstSource, 'repository', 'entrypoint.sh') }],
          },
        ])}\n`,
        { mode: 0o600 },
      );
      chmodSync(first.containerInspect, 0o600);
      const fakeDocker = createFakeDocker(second);
      const productionPathEnv: NodeJS.ProcessEnv = {
        AQUA_CONTROL_PLANE_TEST_ROOT: retentionRoot,
        AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: '',
        AQUA_CONTROL_PLANE_TEST_DOCKER_BIN: fakeDocker,
        AQUA_CONTROL_PLANE_TEST_DOCKER_TIMEOUT_SECONDS: '1',
        AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES: '1024',
        FAKE_DOCKER_CONTAINER_ID: containerId,
        FAKE_DOCKER_INSPECT_JSON: first.containerInspect,
      };

      const valid = runControl(second, ['publish'], productionPathEnv);
      expect(valid.status).toBe(0);
      expect(existsSync(firstSource)).toBe(true);
      expect(existsSync(secondSource)).toBe(true);

      const scenarios = [
        ['inspect-oversize', /exceeded its 1024-byte capture bound/u],
        ['ps-timeout', /container inventory exceeded its 1-second deadline/u],
        ['inspect-timeout', /container inspect exceeded its 1-second deadline/u],
        ['ps-count', /container inventory exceeds the retention bound/u],
        ['ps-no-newline', /container inventory is not newline-terminated/u],
      ] as const;
      for (const [mode, evidence] of scenarios) {
        const rejected = runControl(second, ['publish'], {
          ...productionPathEnv,
          FAKE_DOCKER_MODE: mode,
        });
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toMatch(evidence);
        expect(existsSync(firstSource)).toBe(true);
        expect(existsSync(secondSource)).toBe(true);
      }
    } finally {
      removeFixtureRoot(first.root);
      removeFixtureRoot(second.root);
    }
  }, 30_000);

  it('accepts the signed DR executor terminal artifact schemas', () => {
    for (const phase of ['COMMITTED', 'ROLLED_BACK'] as const) {
      const fixture = createRuntimeFixture();
      try {
        writeTerminalJournalArtifacts(fixture, phase);
        const result = runControl(fixture, ['publish']);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
      } finally {
        removeFixtureRoot(fixture.root);
      }
    }
  });

  it('uses the same strict terminal reader for direct deploy and canonical host admission', () => {
    const fixture = createRuntimeFixture();
    const stateRoot = join(fixture.controlRoot, 'dr-bootstrap');
    const entry = join(stateRoot, `${fixture.mainSha}-1-1`);
    const reader = join(REPO_ROOT, 'scripts/deploy/validate-postgres-dr-state.py');
    const readDirect = (): SpawnSyncReturns<string> =>
      spawnUtf8('/usr/bin/python3', [
        reader,
        stateRoot,
        String(statSync(fixture.controlRoot).uid),
        `sha256:${'3'.repeat(64)}`,
      ]);
    try {
      writeTerminalJournalArtifacts(fixture, 'COMMITTED');
      expect(readDirect().status).toBe(0);
      expect(runControl(fixture, ['publish']).status).toBe(0);
      const files = readdirSync(entry);
      for (const name of files) {
        const path = join(entry, name);
        const original = readFileSync(path);
        rmSync(path);
        expect(readDirect().status).not.toBe(0);
        expect(runControl(fixture, ['publish']).status).not.toBe(0);
        writeFileSync(path, original, { mode: 0o400 });
        chmodSync(path, 0o600);
        expect(readDirect().status).not.toBe(0);
        expect(runControl(fixture, ['publish']).status).not.toBe(0);
        chmodSync(path, 0o400);
        if (name.endsWith('.json') || name.endsWith('.jsonl')) {
          chmodSync(path, 0o600);
          writeFileSync(path, '{invalid');
          chmodSync(path, 0o400);
          expect(readDirect().status).not.toBe(0);
          expect(runControl(fixture, ['publish']).status).not.toBe(0);
          chmodSync(path, 0o600);
          writeFileSync(path, original);
          chmodSync(path, 0o400);
        }
      }
      const extra = join(entry, 'unexpected.json');
      writeFileSync(extra, '{}', { mode: 0o400 });
      expect(readDirect().status).not.toBe(0);
      expect(runControl(fixture, ['publish']).status).not.toBe(0);
      rmSync(extra);
      expect(readDirect().status).toBe(0);
    } finally {
      removeFixtureRoot(fixture.root);
    }
    expect(readFileSync(join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh'), 'utf8')).toContain(
      'scripts/deploy/validate-postgres-dr-state.py',
    );
    expect(readFileSync(CONTROL_PLANE, 'utf8')).toContain('/validate-postgres-dr-state.py');
  });

  it('fails closed for unresolved, corrupt, incomplete, or foreign DR state', () => {
    const scenarios: ReadonlyArray<(fixture: RuntimeFixture) => void> = [
      (fixture) => writeJournal(fixture, terminalJournal('FORWARD_STARTED', fixture.mainSha)),
      (fixture) => writeJournal(fixture, '{broken'),
      (fixture) => writeJournal(fixture, terminalJournal('COMMITTED', fixture.mainSha)),
      (fixture) => {
        writeTerminalJournalArtifacts(fixture, 'COMMITTED');
        const foreign = join(
          fixture.controlRoot,
          'dr-bootstrap',
          `${fixture.mainSha}-1-1`,
          'foreign.json',
        );
        writeFileSync(foreign, '{}\n', { mode: 0o400 });
      },
      (fixture) => {
        writeTerminalJournalArtifacts(fixture, 'COMMITTED');
        const resultPath = join(
          fixture.controlRoot,
          'dr-bootstrap',
          `${fixture.mainSha}-1-1`,
          'result.json',
        );
        chmodSync(resultPath, 0o600);
        writeFileSync(resultPath, '{"result":"success"}\n');
        chmodSync(resultPath, 0o400);
      },
    ];
    for (const arrange of scenarios) {
      const fixture = createRuntimeFixture();
      try {
        arrange(fixture);
        const result = runControl(fixture, ['publish']);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(
          /unresolved|unreadable or corrupt|artifact set|result is invalid|unexpected state/,
        );
        expect(existsSync(join(fixture.controlRoot, 'sources', fixture.mainSha))).toBe(false);
      } finally {
        removeFixtureRoot(fixture.root);
      }
    }
  });

  it('cleans only its deterministic source stage on failure, signal, and safe re-entry', () => {
    const ordinaryFailure = createRuntimeFixture();
    try {
      const failed = runSourcedControl(
        ordinaryFailure,
        'aqua_control_plane_verify_material() { return 91; }; aqua_control_plane_run publish',
      );
      expect(failed.status).not.toBe(0);
      const sourcesRoot = join(ordinaryFailure.controlRoot, 'sources');
      expect(readdirSync(sourcesRoot)).toEqual([]);
    } finally {
      removeFixtureRoot(ordinaryFailure.root);
    }

    const interrupted = createRuntimeFixture();
    try {
      const signalled = runSourcedControl(
        interrupted,
        'aqua_control_plane_verify_material() { kill -TERM "${BASHPID}"; sleep 1; }; aqua_control_plane_run publish',
      );
      expect(signalled.status).not.toBe(0);
      expect(readdirSync(join(interrupted.controlRoot, 'sources'))).toEqual([]);
    } finally {
      removeFixtureRoot(interrupted.root);
    }

    const reentry = createRuntimeFixture();
    try {
      const sourceRoot = join(reentry.controlRoot, 'sources');
      const deterministicStage = join(sourceRoot, `.source.${'e'.repeat(40)}.staging`);
      mkdirSync(deterministicStage, { recursive: true, mode: 0o700 });
      writeFileSync(join(deterministicStage, 'publisher.json.tmp'), '{"format":', {
        mode: 0o400,
      });
      chmodSync(join(deterministicStage, 'publisher.json.tmp'), 0o400);
      chmodSync(reentry.controlRoot, 0o700);
      chmodSync(sourceRoot, 0o700);
      const recovered = runControl(reentry, ['publish']);
      expect(recovered.status).toBe(0);
      expect(existsSync(deterministicStage)).toBe(false);
    } finally {
      removeFixtureRoot(reentry.root);
    }

    const foreignResidue = createRuntimeFixture();
    try {
      const sourceRoot = join(foreignResidue.controlRoot, 'sources');
      mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      chmodSync(foreignResidue.controlRoot, 0o700);
      const foreign = join(sourceRoot, `.source.${foreignResidue.mainSha}.FOREIGN01`);
      mkdirSync(foreign, { mode: 0o700 });
      const rejected = runControl(foreignResidue, ['publish']);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Unexpected production source staging entry');
      expect(existsSync(foreign)).toBe(true);
      expect(existsSync(join(sourceRoot, foreignResidue.mainSha))).toBe(false);
    } finally {
      removeFixtureRoot(foreignResidue.root);
    }
  });

  it('rejects bundle tampering, unsafe member types, and a mutable lock inode', () => {
    const tamperedFixture = createRuntimeFixture();
    try {
      writeFileSync(
        tamperedFixture.bundle,
        Buffer.concat([readFileSync(tamperedFixture.bundle), Buffer.from('x')]),
      );
      const tampered = runControl(tamperedFixture, ['publish']);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('bundle digest mismatch');
    } finally {
      removeFixtureRoot(tamperedFixture.root);
    }

    const unsafeFixture = createRuntimeFixture();
    try {
      const python = [
        'import io,tarfile,sys',
        'with tarfile.open(sys.argv[1], "w:gz") as archive:',
        ' kind=sys.argv[2]',
        ' info=tarfile.TarInfo("../escape" if kind == "path" else f"unsafe-{kind}")',
        ' info.mtime=0',
        ' if kind == "path":',
        '  info.size=1',
        '  archive.addfile(info, io.BytesIO(b"x"))',
        ' elif kind == "symlink":',
        '  info.type=tarfile.SYMTYPE',
        '  info.linkname="/etc/passwd"',
        '  archive.addfile(info)',
        ' else:',
        '  info.type=tarfile.CHRTYPE',
        '  info.devmajor=1',
        '  info.devminor=3',
        '  archive.addfile(info)',
      ].join('\n');
      for (const kind of ['path', 'symlink', 'device']) {
        const unsafeBundle = join(unsafeFixture.root, `unsafe-${kind}.tar.gz`);
        const created = spawnUtf8('/usr/bin/python3', ['-c', python, unsafeBundle, kind]);
        expect(created.status).toBe(0);
        chmodSync(unsafeBundle, 0o600);
        const unsafeHash = createHash('sha256').update(readFileSync(unsafeBundle)).digest('hex');
        const unsafe = runControl(unsafeFixture, ['publish'], {
          PRODUCTION_HOST_BUNDLE_PATH: unsafeBundle,
          PRODUCTION_HOST_BUNDLE_SHA256: unsafeHash,
        });
        expect(unsafe.status).not.toBe(0);
        expect(unsafe.stderr).toMatch(/unsafe or duplicate|unsafe bundle member type/);
      }
      expect(existsSync(join(unsafeFixture.controlRoot, 'escape'))).toBe(false);
    } finally {
      removeFixtureRoot(unsafeFixture.root);
    }

    const lockFixture = createRuntimeFixture();
    try {
      expect(runControl(lockFixture, ['publish']).status).toBe(0);
      const unsafeTestRoot = runControl(lockFixture, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: `${lockFixture.controlRoot}/../escape`,
      });
      expect(unsafeTestRoot.status).not.toBe(0);
      expect(unsafeTestRoot.stderr).toContain('not canonical');

      chmodSync(lockFixture.controlRoot, 0o775);
      const wrongRootMode = runControl(lockFixture, ['publish']);
      expect(wrongRootMode.status).not.toBe(0);
      expect(wrongRootMode.stderr).toContain('control-plane root mode mismatch');
      expect(statSync(lockFixture.controlRoot).mode & 0o777).toBe(0o775);
      chmodSync(lockFixture.controlRoot, 0o700);

      const lockPath = join(lockFixture.controlRoot, 'control-plane.lock');
      chmodSync(lockPath, 0o666);
      const wrongMode = runControl(lockFixture, ['publish']);
      expect(wrongMode.status).not.toBe(0);
      expect(wrongMode.stderr).toContain('lock mode must be 0600');

      chmodSync(lockPath, 0o600);
      const wrongInode = spawnUtf8(
        '/bin/bash',
        [
          '-c',
          `exec 9<>/dev/null; export AQUA_CONTROL_PLANE_LOCK_FD=9 AQUA_CONTROL_PLANE_LOCK_MODE=exclusive; source ${JSON.stringify(CONTROL_PLANE)}; aqua_control_plane_lock_acquire exclusive 1`,
        ],
        { env: runtimeEnv(lockFixture) },
      );
      expect(wrongInode.status).not.toBe(0);
      expect(wrongInode.stderr).toContain('inode mismatch');

      rmSync(lockPath);
      symlinkSync('/dev/null', lockPath);
      const symlink = runControl(lockFixture, ['publish']);
      expect(symlink.status).not.toBe(0);
      expect(symlink.stderr).toContain('regular non-symlink');
    } finally {
      removeFixtureRoot(lockFixture.root);
    }
  });

  it('converges only the safe legacy 0755 root and rejects hostile ancestry', () => {
    const legacyFixture = createRuntimeFixture();
    try {
      mkdirSync(legacyFixture.controlRoot, { mode: 0o755 });
      chmodSync(legacyFixture.controlRoot, 0o755);
      const migrated = runControl(legacyFixture, ['publish']);
      expect(migrated.status).toBe(0);
      expect(migrated.stderr).toBe('');
      expect(statSync(legacyFixture.controlRoot).mode & 0o777).toBe(0o700);
    } finally {
      removeFixtureRoot(legacyFixture.root);
    }

    const writableParentFixture = createRuntimeFixture();
    try {
      const writableParent = join(writableParentFixture.root, 'writable-parent');
      const unsafeRoot = join(writableParent, 'control-root');
      mkdirSync(writableParent, { mode: 0o777 });
      chmodSync(writableParent, 0o777);
      const rejected = runControl(writableParentFixture, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: unsafeRoot,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('control-plane parent directory is writable');
      expect(existsSync(unsafeRoot)).toBe(false);
    } finally {
      removeFixtureRoot(writableParentFixture.root);
    }

    const symlinkParentFixture = createRuntimeFixture();
    try {
      const realParent = join(symlinkParentFixture.root, 'real-parent');
      const linkedParent = join(symlinkParentFixture.root, 'linked-parent');
      mkdirSync(realParent, { mode: 0o700 });
      symlinkSync(realParent, linkedParent);
      const rejected = runControl(symlinkParentFixture, ['publish'], {
        AQUA_CONTROL_PLANE_TEST_ROOT: join(linkedParent, 'control-root'),
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('path component is not a real directory');
      expect(existsSync(join(realParent, 'control-root'))).toBe(false);
    } finally {
      removeFixtureRoot(symlinkParentFixture.root);
    }
  });

  it('converges the exact legacy release root once under the exclusive lock', () => {
    const fixture = createRuntimeFixture('legacy-release-root');
    const releasesRoot = join(fixture.controlRoot, 'releases');
    const prepare = (): SpawnSyncReturns<string> =>
      runSourcedControl(
        fixture,
        'aqua_control_plane_lock_acquire exclusive 1; aqua_control_plane_prepare_releases_root false',
      );
    try {
      expect(runControl(fixture, ['publish']).status).toBe(0);
      mkdirSync(join(releasesRoot, 'preserved'), { recursive: true, mode: 0o700 });
      chmodSync(releasesRoot, 0o755);

      const migrated = prepare();
      expect(migrated.status).toBe(0);
      expect(migrated.stderr).toBe('');
      expect(statSync(releasesRoot).mode & 0o777).toBe(0o700);
      expect(existsSync(join(releasesRoot, 'preserved'))).toBe(true);

      const repeated = prepare();
      expect(repeated.status).toBe(0);
      expect(repeated.stderr).toBe('');
      expect(statSync(releasesRoot).mode & 0o777).toBe(0o700);

      chmodSync(releasesRoot, 0o775);
      const writable = prepare();
      expect(writable.status).not.toBe(0);
      expect(writable.stderr).toContain('release root mode is neither 0700 nor exact legacy 0755');
      expect(statSync(releasesRoot).mode & 0o777).toBe(0o775);

      rmSync(releasesRoot, { recursive: true });
      symlinkSync('/tmp', releasesRoot);
      const symlink = prepare();
      expect(symlink.status).not.toBe(0);
      expect(symlink.stderr).toContain('release root is not a real directory');

      const controlPlane = readFileSync(CONTROL_PLANE, 'utf8');
      expect(controlPlane).toContain(
        'descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
      );
      expect(controlPlane).toContain(
        '(path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino)',
      );
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });

  it('does not replace an existing source whose exact marker or bytes drifted', () => {
    const fixture = createRuntimeFixture();
    try {
      const published = runControl(fixture, ['publish']);
      expect(published.status).toBe(0);
      const trackedPath = join(published.stdout.trim(), 'entrypoint.sh');
      const sourceRoot = dirname(published.stdout.trim());
      chmodSync(sourceRoot, 0o755);
      chmodSync(trackedPath, 0o444);
      const wrongMode = runControl(fixture, ['publish']);
      expect(wrongMode.status).not.toBe(0);
      expect(wrongMode.stderr).toContain('file mode map is not exact');
      expect(statSync(sourceRoot).mode & 0o777).toBe(0o755);

      chmodSync(trackedPath, 0o644);
      writeFileSync(trackedPath, '#!/bin/false\n');
      chmodSync(trackedPath, 0o555);

      const repeated = runControl(fixture, ['publish']);
      expect(repeated.status).not.toBe(0);
      expect(repeated.stderr).toContain('tracked file hash mismatch');
      expect(readFileSync(trackedPath, 'utf8')).toBe('#!/bin/false\n');
    } finally {
      removeFixtureRoot(fixture.root);
    }
  });
});
