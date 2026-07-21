import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CAPACITY = join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh');
const CONTROL_PLANE = join(REPO_ROOT, 'scripts/deploy/production-host-control-plane.sh');
const DEPLOY_PATHS = join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh');
const SERVICE_CATALOG = join(REPO_ROOT, 'infrastructure/deploy/service-catalog.deploy.vars');
const CAPACITY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-capacity-maintenance.yml');
const RUNTIME_BUNDLE_PRODUCER = join(
  REPO_ROOT,
  'tools/scripts/ci/prepare-production-host-runtime-bundle.sh',
);
const IMAGE_PREFIX = 'ghcr.io/okan-wqm/aquaculture_platform';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function executable(path: string, content: string): void {
  write(path, content);
  chmodSync(path, 0o755);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface CapacityFixture {
  readonly root: string;
  readonly controlRoot: string;
  readonly fakeBin: string;
  readonly dockerLog: string;
  readonly inventory: string;
  readonly containers: string;
  readonly capacityScript: string;
  readonly controlPlaneScript: string;
}

function createCapacityFixture(): CapacityFixture {
  const root = mkdtempSync(join(tmpdir(), 'aqua-capacity-control-'));
  const controlRoot = join(root, 'control');
  const fakeBin = join(root, 'bin');
  const dockerLog = join(root, 'docker.log');
  const inventory = join(root, 'images.tsv');
  const containers = join(root, 'containers.tsv');
  const capacityScript = join(root, 'runtime/scripts/deploy/droplet-capacity.sh');
  const controlPlaneScript = join(root, 'runtime/scripts/deploy/production-host-control-plane.sh');
  const deployPathsScript = join(root, 'runtime/scripts/deploy/deploy-paths.sh');
  mkdirSync(controlRoot, { mode: 0o700 });
  mkdirSync(join(controlRoot, 'releases'), { mode: 0o700 });
  mkdirSync(fakeBin);
  mkdirSync(dirname(capacityScript), { recursive: true });
  writeFileSync(inventory, '');
  writeFileSync(containers, '');
  writeFileSync(dockerLog, '');
  copyFileSync(CAPACITY, capacityScript);
  chmodSync(capacityScript, 0o755);
  const controlPlaneSource = readFileSync(CONTROL_PLANE, 'utf8').replace(
    /^export PATH=.*$/m,
    'export PATH="${AQUA_CONTROL_PLANE_TEST_PATH:-/usr/bin:/bin}"',
  );
  writeFileSync(controlPlaneScript, controlPlaneSource, { mode: 0o755 });
  copyFileSync(DEPLOY_PATHS, deployPathsScript);
  mkdirSync(join(root, 'runtime/infrastructure/deploy'), { recursive: true });
  copyFileSync(
    SERVICE_CATALOG,
    join(root, 'runtime/infrastructure/deploy/service-catalog.deploy.vars'),
  );
  executable(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${DOCKER_LOG}"
case "\${1:-}:\${2:-}" in
  info:*) printf '/var/lib/docker\n' ;;
  system:df) printf '1GB\n' ;;
  ps:-aq) awk -F '\\t' 'NF {print $1}' "\${CONTAINER_INVENTORY}" ;;
  inspect:*)
    target="\${!#}"
    awk -F '\\t' -v target="\${target}" '$1 == target {print $2; found=1} END {exit !found}' "\${CONTAINER_INVENTORY}"
    ;;
  image:ls) cat "\${IMAGE_INVENTORY}" ;;
  rmi:*)
    if [ -n "\${FAIL_RMI_REF:-}" ] && [ "\${2:-}" = "\${FAIL_RMI_REF}" ]; then
      printf 'synthetic rmi failure for %s\n' "\${2}" >&2
      exit 55
    fi
    if [ "\${KILL_AFTER_RMI:-false}" = true ]; then
      printf 'mutation-crossed\n' > "\${MUTATION_MARKER:?}"
      kill -KILL "\${PPID}"
    fi
    ;;
  *) printf 'unexpected docker invocation: %s\n' "$*" >&2; exit 98 ;;
esac
`,
  );
  return {
    root,
    controlRoot,
    fakeBin,
    dockerLog,
    inventory,
    containers,
    capacityScript,
    controlPlaneScript,
  };
}

function fixtureEnv(
  fixture: CapacityFixture,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
    HOME: fixture.root,
    LC_ALL: 'C',
    NODE_ENV: 'test',
    AQUA_CONTROL_PLANE_TEST_ROOT: fixture.controlRoot,
    AQUA_CONTROL_PLANE_TEST_PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AQUA_CAPACITY_TEST_LOCK_TIMEOUT_SECONDS: '1',
    DEPLOY_STATE_ROOT: join(fixture.controlRoot, 'releases'),
    CAPACITY_DISK_USAGE_MODE: 'off',
    DOCKER_ROOT_DIR: '/var/lib/docker',
    IMAGE_PREFIX,
    DOCKER_LOG: fixture.dockerLog,
    IMAGE_INVENTORY: fixture.inventory,
    CONTAINER_INVENTORY: fixture.containers,
    ...overrides,
  };
}

function runCapacity(
  fixture: CapacityFixture,
  operation: string,
  overrides: NodeJS.ProcessEnv = {},
  script = fixture.capacityScript,
): ReturnType<typeof spawnSync> {
  return spawnSync('/bin/bash', [script, operation], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: fixtureEnv(fixture, overrides),
  });
}

function createRollbackManifest(
  fixture: CapacityFixture,
  imageId: string,
  releaseSha: string,
  timestamp = '20260718T120000Z',
  empty = false,
): { readonly manifest: string; readonly checksum: string; readonly release: string } {
  const release = join(fixture.controlRoot, 'releases', `${releaseSha}-${timestamp}`);
  mkdirSync(release, { mode: 0o700 });
  const rollbackState = join(release, 'rollback-state');
  mkdirSync(rollbackState, { mode: 0o700 });
  const content = empty ? '' : `farm-service\t${imageId}\n`;
  const manifest = join(rollbackState, 'rollback-images.tsv');
  const checksum = join(rollbackState, 'rollback-images.sha256');
  writeFileSync(manifest, content, { mode: 0o600 });
  writeFileSync(checksum, `${sha256(content)}\n`, { mode: 0o600 });
  return { manifest, checksum, release };
}

function writeTerminalDrState(fixture: CapacityFixture, mainSha: string): void {
  const stateDirectory = join(fixture.controlRoot, 'dr-bootstrap', `${mainSha}-1-1`);
  const candidateDigest = `sha256:${'2'.repeat(64)}`;
  const candidateImage = `sha256:${'a'.repeat(64)}`;
  const priorImage = `sha256:${'f'.repeat(64)}`;
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(fixture.controlRoot, 'dr-bootstrap'), 0o700);
  const files: Record<string, string> = {
    'phase.json': `${JSON.stringify({
      candidate: {
        image_digest: candidateDigest,
        main_sha: mainSha,
        repository: 'Okan-wqm/aquaculture_platform',
        run_attempt: '1',
        run_id: '1',
      },
      candidate_image_id: candidateImage,
      occurred_at: '2026-07-18T00:00:00Z',
      phase: 'COMMITTED',
      prior_image_id: priorImage,
      schema_version: 1,
    })}\n`,
    'postgres-forward.override.yml': 'services:\n  postgres:\n    image: candidate\n',
    'postgres-rollback.override.yml': 'services:\n  postgres:\n    image: prior\n',
    'image-signature.json': `${JSON.stringify([{ critical: { identity: mainSha } }])}\n`,
    'image-attestations.jsonl': `${JSON.stringify({ payload: 'c2lnbmVk' })}\n`,
    'local-candidate.json': `${JSON.stringify({
      bootstrap: { allowed_compose_services: ['postgres'], channel: 'provider-console' },
      build: { run_attempt: '1', run_id: '1', workflow: 'fixture' },
      image: {
        digest: candidateDigest,
        immutable_tag: `${mainSha}-1-1`,
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
        main_sha: mainSha,
        ref: 'refs/heads/main',
        repository: 'Okan-wqm/aquaculture_platform',
      },
    })}\n`,
    'result.json': `${JSON.stringify({
      active_container_id: '5'.repeat(64),
      completed_at: '2026-07-18T00:00:01Z',
      image_digest: candidateDigest,
      image_id: candidateImage,
      main_sha: mainSha,
      prior_image_id: priorImage,
      result: 'success',
      run_attempt: '1',
      run_id: '1',
    })}\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(stateDirectory, name);
    writeFileSync(path, content, { mode: 0o400 });
    chmodSync(path, 0o400);
  }
}

function publishCurrentReleaseMarker(
  fixture: CapacityFixture,
  release: string,
  releaseSha: string,
): void {
  const releaseId = release.slice(release.lastIndexOf('/') + 1);
  const imageManifest = `farm-service\t${IMAGE_PREFIX}/farm-service\tsha256:${'a'.repeat(64)}\n`;
  writeFileSync(join(release, 'image-digests.tsv'), imageManifest, { mode: 0o600 });
  writeFileSync(
    join(fixture.controlRoot, 'current-release.json'),
    `${JSON.stringify({
      image_digest_manifest_sha256: sha256(imageManifest),
      main_sha: releaseSha,
      promoted_at: '2026-07-19T00:00:00Z',
      release_id: releaseId,
      schema_version: 1,
    })}\n`,
    { mode: 0o400 },
  );
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function publishVerifiedCapacitySource(fixture: CapacityFixture): {
  readonly mainSha: string;
  readonly sourceRoot: string;
  readonly sourceDir: string;
  readonly sourceFixture: string;
  readonly producer: string;
  readonly containerInspect: string;
} {
  const sourceFixture = join(fixture.root, 'source-proof-fixture');
  const producer = join(
    sourceFixture,
    'tools/scripts/ci/prepare-production-host-runtime-bundle.sh',
  );
  mkdirSync(dirname(producer), { recursive: true });
  copyFileSync(RUNTIME_BUNDLE_PRODUCER, producer);
  chmodSync(producer, 0o755);
  write(
    join(sourceFixture, 'scripts/deploy/check-service-health.ts'),
    "process.stdout.write('health\\n');\n",
  );
  write(
    join(sourceFixture, 'scripts/deploy/assert-service-signals.ts'),
    "process.stdout.write('signals\\n');\n",
  );
  write(join(sourceFixture, 'infrastructure/docker/nats/nats.conf'), 'server_name: fixture\n');
  write(
    join(sourceFixture, 'apps/example/src/database/migrations/1800000000000-Example.ts'),
    'export class Example1800000000000 {}\n',
  );
  write(
    join(sourceFixture, 'apps/db-migrate/src/schema-registry.ts'),
    'export const schemas = [];\n',
  );
  write(join(sourceFixture, 'entrypoint.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(sourceFixture, 'entrypoint.sh'), 0o755);
  write(join(sourceFixture, '.gitignore'), 'node_modules/\n');
  const workspaceNodeModules = existsSync(join(REPO_ROOT, 'node_modules/esbuild/bin/esbuild'))
    ? join(REPO_ROOT, 'node_modules')
    : '/var/aqua-saas/node_modules';
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: sourceFixture, LC_ALL: 'C' };
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
    [
      '-c',
      'user.name=Aqua Test',
      '-c',
      'user.email=aqua-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'test: capacity source proof',
    ],
  ]) {
    const gitResult = spawnSync('/usr/bin/git', args, {
      cwd: sourceFixture,
      encoding: 'utf8',
      env: gitEnv,
    });
    if (gitResult.status !== 0) {
      throw new Error(`${gitResult.stdout}${gitResult.stderr}`);
    }
  }
  symlinkSync(workspaceNodeModules, join(sourceFixture, 'node_modules'));
  const shaResult = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: sourceFixture,
    encoding: 'utf8',
    env: gitEnv,
  });
  if (shaResult.status !== 0) {
    throw new Error(`${shaResult.stdout}${shaResult.stderr}`);
  }
  const mainSha = shaResult.stdout.trim();
  const bundle = join(sourceFixture, 'runtime.tar.gz');
  const produced = spawnSync('/bin/bash', [producer], {
    cwd: sourceFixture,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: sourceFixture,
      LC_ALL: 'C',
      NODE_BIN: process.execPath,
      OUTPUT_PATH: bundle,
      SOURCE_SHA: mainSha,
    },
  });
  if (produced.status !== 0) {
    throw new Error(`${produced.stdout}${produced.stderr}`);
  }
  const containerInspect = join(sourceFixture, 'container-inspect.json');
  writeFileSync(containerInspect, '[]\n', { mode: 0o600 });
  chmodSync(containerInspect, 0o600);
  const published = spawnSync('/bin/bash', [CONTROL_PLANE, 'publish'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: sourceFixture,
      LC_ALL: 'C',
      NODE_ENV: 'test',
      AQUA_CONTROL_PLANE_TEST_ROOT: fixture.controlRoot,
      AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: containerInspect,
      PRODUCTION_HOST_BUNDLE_PATH: bundle,
      PRODUCTION_HOST_BUNDLE_SHA256: produced.stdout.trim(),
      PRODUCTION_HOST_MAIN_SHA: mainSha,
    },
  });
  if (published.status !== 0) {
    throw new Error(`${published.stdout}${published.stderr}`);
  }
  const sourceRoot = join(fixture.controlRoot, 'sources', mainSha);
  return {
    mainSha,
    sourceRoot,
    sourceDir: join(sourceRoot, 'repository'),
    sourceFixture,
    producer,
    containerInspect,
  };
}

function publishDescendantCapacitySource(
  fixture: CapacityFixture,
  predecessor: ReturnType<typeof publishVerifiedCapacitySource>,
): ReturnType<typeof publishVerifiedCapacitySource> {
  write(join(predecessor.sourceFixture, 'descendant.txt'), 'descendant\n');
  const gitEnv = {
    PATH: '/usr/bin:/bin',
    HOME: predecessor.sourceFixture,
    LC_ALL: 'C',
  };
  for (const args of [
    ['add', 'descendant.txt'],
    [
      '-c',
      'user.name=Aqua Test',
      '-c',
      'user.email=aqua-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'test: descendant capacity source proof',
    ],
  ]) {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: predecessor.sourceFixture,
      encoding: 'utf8',
      env: gitEnv,
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}${result.stderr}`);
    }
  }
  const shaResult = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: predecessor.sourceFixture,
    encoding: 'utf8',
    env: gitEnv,
  });
  if (shaResult.status !== 0) {
    throw new Error(`${shaResult.stdout}${shaResult.stderr}`);
  }
  const mainSha = shaResult.stdout.trim();
  const bundle = join(predecessor.sourceFixture, 'runtime-descendant.tar.gz');
  const produced = spawnSync('/bin/bash', [predecessor.producer], {
    cwd: predecessor.sourceFixture,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: predecessor.sourceFixture,
      LC_ALL: 'C',
      NODE_BIN: process.execPath,
      OUTPUT_PATH: bundle,
      SOURCE_SHA: mainSha,
    },
  });
  if (produced.status !== 0) {
    throw new Error(`${produced.stdout}${produced.stderr}`);
  }
  const published = spawnSync('/bin/bash', [CONTROL_PLANE, 'publish'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: predecessor.sourceFixture,
      LC_ALL: 'C',
      NODE_ENV: 'test',
      AQUA_CONTROL_PLANE_TEST_ROOT: fixture.controlRoot,
      AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON: predecessor.containerInspect,
      PRODUCTION_HOST_BUNDLE_PATH: bundle,
      PRODUCTION_HOST_BUNDLE_SHA256: produced.stdout.trim(),
      PRODUCTION_HOST_MAIN_SHA: mainSha,
    },
  });
  if (published.status !== 0) {
    throw new Error(`${published.stdout}${published.stderr}`);
  }
  const sourceRoot = join(fixture.controlRoot, 'sources', mainSha);
  return {
    ...predecessor,
    mainSha,
    sourceRoot,
    sourceDir: join(sourceRoot, 'repository'),
  };
}

describe('droplet capacity production control plane', () => {
  it('pins lock, rollback inventory, image-only GC, and root-path redaction statically', () => {
    const capacity = readFileSync(CAPACITY, 'utf8');
    const capacityWorkflow = readFileSync(CAPACITY_WORKFLOW, 'utf8');
    const rootRedactionBranches = Array.from(
      capacity.matchAll(/if \[\[ "\$\{decoded_path\}" == \/root\/\* \]\]; then([\s\S]*?)else/g),
      (match) => match[1],
    );

    expect(capacity).toContain('source "${CAPACITY_SCRIPT_DIR}/production-host-control-plane.sh"');
    expect(capacity).toContain('aqua_control_plane_lock_acquire "${lock_mode}" "${lock_timeout}"');
    expect(capacity).toContain('aqua_control_plane_guard_dr_state');
    expect(capacity).toContain('readonly DEPLOY_STATE_ROOT_DEFAULT=/var/lib/aqua/deploy/releases');
    expect(capacity).not.toMatch(/^ROLLBACK_MANIFEST=/m);
    expect(capacity).not.toMatch(/docker\s+(?:image|system)\s+prune/);
    expect(capacity).toContain('docker rmi "${ref}"');
    expect(capacity).toContain('CAPACITY_HOST_ARTIFACT_ALLOWLIST=(');
    expect(capacity.match(/\/swapfile-cleanup-20260610/g)).toHaveLength(2);
    expect(rootRedactionBranches).toHaveLength(2);
    for (const redactionBranch of rootRedactionBranches) {
      expect(redactionBranch).toContain('path_scope=/root path_sha256=');
      expect(redactionBranch).not.toContain('path_base64=');
      expect(redactionBranch).not.toContain('path=%q');
    }
    expect(capacity).toContain('completed_bytes_lower_bound=');
    expect(capacity).toContain('omitted_scope_lower_bound=');
    expect(capacity).toContain('coverage=%s');
    expect(capacity).toContain('CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY=128');
    expect(capacity).toContain("awk 'NR <= 40'");
    expect(capacity).toContain('CAPACITY_MAX_RELEASE_STATE_DIRECTORIES=512');
    expect(capacity).toContain('CAPACITY_MAX_ROLLBACK_MANIFEST_ROWS=512');
    expect(capacity).toContain('capacity_gc_release_authority=markerless-bootstrap');
    expect(capacity).toContain('bootstrap-image-gc.json');
    expect(capacity).toContain('AQUA_PRODUCTION_SOURCE_ROOT');
    expect(capacity).toContain('aqua_control_plane_verify_published_source');
    expect(capacity).toContain('capacity_enter_control_plane shared false');
    expect(capacity.match(/capacity_enter_control_plane exclusive true/g)).toHaveLength(5);
    expect(capacity).toContain('local -r HOST_ARTIFACT_GC_DRY_RUN=true');
    expect(capacity).toContain('local -r HOST_ARTIFACT_GC_DRY_RUN=false');
    expect(capacity).not.toContain('HOST_ARTIFACT_GC_DRY_RUN="${HOST_ARTIFACT_GC_DRY_RUN:-false}"');
    expect(capacity).toContain('findmnt --json --list --output TARGET,SOURCE');
    expect(capacity).toContain('losetup --json --list --output NAME,BACK-FILE');
    expect(capacity).toContain('fuser -a -I "${candidate_path}"');
    expect(capacity).not.toContain('findmnt -rn');
    expect(capacity).not.toContain('fuser -s "${candidate_path}"');
    expect(capacityWorkflow).toContain("OPERATION: ${{ inputs.operation || 'safe-image-gc' }}");
    expect(capacityWorkflow).toContain(
      'safe-host-artifact-gc-dry-run) REMOTE_MODE=lock-exec; OPERATION=host-artifact-gc-dry-run ;;',
    );
    expect(capacityWorkflow).toContain(
      'safe-host-artifact-gc) REMOTE_MODE=lock-exec; OPERATION=host-artifact-gc ;;',
    );
    expect(capacityWorkflow).not.toContain('append_env HOST_ARTIFACT_GC_DRY_RUN');
    expect(capacityWorkflow).not.toContain('image_prefix:');
    expect(capacityWorkflow).not.toContain('deploy_sha:');
    expect(capacityWorkflow).not.toContain('append_env IMAGE_PREFIX');
    const payloadReady = capacityWorkflow.indexOf(
      '/bin/bash --noprofile --norc "${EXACT_PAYLOAD_PRODUCER}"',
    );
    const mutationAuthority = capacityWorkflow.indexOf(
      'EXPECTED_SHA="${SOURCE_SHA}" GH_TOKEN="${MAIN_AUTHORITY_TOKEN}" node',
    );
    const protectedSsh = capacityWorkflow.indexOf('SSH_PRIVATE_KEY_FD="${SSH_PRIVATE_KEY_FD}"');
    expect(payloadReady).toBeGreaterThan(0);
    expect(mutationAuthority).toBeGreaterThan(payloadReady);
    expect(protectedSsh).toBeGreaterThan(mutationAuthority);
    expect(
      capacityWorkflow.indexOf(
        'unset DROPLET_HOST DROPLET_USER DROPLET_SSH_KEY DROPLET_SSH_FINGERPRINT GH_TOKEN',
      ),
    ).toBeLessThan(payloadReady);
    expect(capacityWorkflow).toContain('exec {SSH_PRIVATE_KEY_FD}< "${SSH_KEY_STAGE}"');
    expect(capacityWorkflow).toContain('rm -f -- "${SSH_KEY_STAGE}"');
    expect(capacity).toContain(
      'CAPACITY_DISK_USAGE_MODE=off bash scripts/deploy/droplet-capacity.sh report',
    );
    expect(capacity).toContain('bash scripts/deploy/droplet-capacity.sh gc');
    expect(capacity).toContain(
      'CAPACITY_GC_MODE=off CAPACITY_DISK_USAGE_MODE=deep bash scripts/deploy/droplet-capacity.sh gate',
    );
  });

  it('aggregates all bounded hotspot scopes even when detail output is truncated', () => {
    const fixture = createCapacityFixture();
    const hotspotRoot = join(fixture.root, 'hotspot');
    const scopeList = join(fixture.root, 'hotspot-scopes');
    try {
      mkdirSync(hotspotRoot);
      const scaledCapacity = readFileSync(fixture.capacityScript, 'utf8')
        .replace(
          'CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY=128',
          'CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY=8',
        )
        .replace("awk 'NR <= 40'", "awk 'NR <= 4'");
      writeFileSync(fixture.capacityScript, scaledCapacity, { mode: 0o755 });
      const scopes = Array.from({ length: 9 }, (_, index) => {
        const scope = join(hotspotRoot, `scope-${String(index).padStart(3, '0')}`);
        mkdirSync(scope);
        return scope;
      });
      writeFileSync(scopeList, `${scopes.join('\n')}\n`);
      executable(
        join(fixture.fakeBin, 'find'),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = /tmp ]; then
  while IFS= read -r scope; do [ -n "\${scope}" ] && printf '%s\\0' "\${scope}"; done < "\${HOTSPOT_SCOPES}"
fi
`,
      );
      executable(
        join(fixture.fakeBin, 'du'),
        `#!/usr/bin/env bash
set -euo pipefail
scope="\${!#}"
printf '100\\t%s\\0' "\${scope}"
`,
      );
      executable(
        join(fixture.fakeBin, 'timeout'),
        `#!/usr/bin/env bash
set -euo pipefail
shift 3
exec "$@"
`,
      );

      const result = runCapacity(fixture, 'report', {
        CAPACITY_DISK_USAGE_MODE: 'deep',
        CAPACITY_DU_TIMEOUT_SECONDS: '30',
        HOTSPOT_SCOPES: scopeList,
      });
      const output = combinedOutput(result);
      expect(result.status).toBe(0);
      expect(output).toContain(
        'hotspot_path=/tmp present=true completed_bytes_lower_bound=800 completed_scope_count=8 unavailable_scope_count=0 omitted_scope_lower_bound=1 coverage=partial',
      );
      expect(output.match(/^\s+bytes=/gm)).toHaveLength(4);
      expect(output).toContain('discovery_scope_limit');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('protects canonical rollback/running/current IDs and observes every explicit removal failure', () => {
    const fixture = createCapacityFixture();
    const protectedId = `sha256:${'1'.repeat(64)}`;
    const runningId = `sha256:${'2'.repeat(64)}`;
    const currentId = `sha256:${'3'.repeat(64)}`;
    const oldId = `sha256:${'4'.repeat(64)}`;
    const rollbackId = `sha256:${'5'.repeat(64)}`;
    const unclassifiedId = `sha256:${'6'.repeat(64)}`;
    const historicalId = `sha256:${'8'.repeat(64)}`;
    const rogueId = `sha256:${'9'.repeat(64)}`;
    const drCandidateId = `sha256:${'a'.repeat(64)}`;
    const drPriorId = `sha256:${'f'.repeat(64)}`;
    const currentSha = 'b'.repeat(40);
    const oldSha = 'c'.repeat(40);
    try {
      const state = createRollbackManifest(fixture, protectedId, currentSha);
      createRollbackManifest(fixture, historicalId, oldSha);
      writeTerminalDrState(fixture, currentSha);
      writeFileSync(fixture.containers, `farm-container\t${runningId}\n`);
      writeFileSync(
        fixture.inventory,
        [
          `${IMAGE_PREFIX}/farm-service\trollback-protected\t${protectedId}`,
          `${IMAGE_PREFIX}/farm-service\t${oldSha}\t${runningId}`,
          `${IMAGE_PREFIX}/farm-service\t${currentSha}\t${currentId}`,
          `${IMAGE_PREFIX}/farm-service\t${oldSha}\t${oldId}`,
          `${IMAGE_PREFIX}/farm-service\trollback-superseded\t${rollbackId}`,
          `${IMAGE_PREFIX}/farm-service\tincident-clean\t${unclassifiedId}`,
          `${IMAGE_PREFIX}/farm-service\trollback-historical\t${historicalId}`,
          `${IMAGE_PREFIX}/farm-service\trollback-dr-candidate\t${drCandidateId}`,
          `${IMAGE_PREFIX}/farm-service\trollback-dr-prior\t${drPriorId}`,
          `${IMAGE_PREFIX}/rogue-service\t${oldSha}\t${rogueId}`,
          `<none>\t<none>\tsha256:${'7'.repeat(64)}`,
        ].join('\n') + '\n',
      );

      const missingSha = runCapacity(fixture, 'gc');
      expect(missingSha.status).not.toBe(0);
      expect(combinedOutput(missingSha)).toContain('capacity_gc_current_release_unavailable');
      expect(readFileSync(fixture.dockerLog, 'utf8')).toBe('');

      const removed = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: currentSha,
        DEPLOY_STATE_DIR: state.release,
      });
      const removedOutput = combinedOutput(removed);
      const dockerLog = readFileSync(fixture.dockerLog, 'utf8');
      expect({
        status: removed.status,
        output: removedOutput,
        dockerLog,
      }).toEqual(expect.objectContaining({ status: 0 }));
      expect(dockerLog).toContain(`rmi ${IMAGE_PREFIX}/farm-service:${oldSha}`);
      expect(dockerLog).toContain(`rmi ${IMAGE_PREFIX}/farm-service:rollback-superseded`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:incident-clean`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:rollback-historical`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:rollback-dr-candidate`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:rollback-dr-prior`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/rogue-service:${oldSha}`);
      expect(dockerLog).not.toContain('rmi ' + `${IMAGE_PREFIX}/farm-service:${currentSha}`);
      expect(dockerLog).not.toContain('rmi ' + `${IMAGE_PREFIX}/farm-service:rollback-protected`);
      expect(dockerLog).not.toMatch(/image prune|system prune/);
      expect(removedOutput).toContain('global_prune=false');
      expect(removedOutput).toContain(
        `capacity_gc_release_authority=markerless-bootstrap sha=${currentSha}`,
      );
      expect(
        JSON.parse(readFileSync(join(fixture.controlRoot, 'bootstrap-image-gc.json'), 'utf8')),
      ).toEqual(expect.objectContaining({ incoming_sha: currentSha, state: 'COMPLETED' }));

      // Once the first deploy publishes its marker, marker authority replaces
      // bootstrap permanently even when stale candidate variables remain.
      publishCurrentReleaseMarker(fixture, state.release, currentSha);

      writeFileSync(fixture.dockerLog, '');
      writeFileSync(state.checksum, `${'0'.repeat(64)}\n`);
      const corrupt = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: currentSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(corrupt.status).not.toBe(0);
      expect(combinedOutput(corrupt)).toContain('rollback_state_checksum_mismatch');
      expect(readFileSync(fixture.dockerLog, 'utf8')).not.toMatch(/^rmi /m);

      const validManifest = readFileSync(state.manifest, 'utf8');
      writeFileSync(state.checksum, `${sha256(validManifest)}\n`);
      writeFileSync(fixture.dockerLog, '');
      const failingRef = `${IMAGE_PREFIX}/farm-service:${oldSha}`;
      const failedRemoval = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: currentSha,
        DEPLOY_STATE_DIR: state.release,
        FAIL_RMI_REF: failingRef,
      });
      expect(failedRemoval.status).not.toBe(0);
      expect(combinedOutput(failedRemoval)).toContain('capacity_gc_remove_failed');
      expect(readFileSync(fixture.dockerLog, 'utf8')).toContain(`rmi ${failingRef}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects operator image-prefix overrides before Docker inventory', () => {
    const fixture = createCapacityFixture();
    try {
      const result = runCapacity(fixture, 'gc', {
        IMAGE_PREFIX: 'ghcr.io/attacker/rogue',
      });
      expect(result.status).not.toBe(0);
      expect(combinedOutput(result)).toContain('capacity_image_prefix_override_rejected');
      expect(readFileSync(fixture.dockerLog, 'utf8')).toBe('');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts ABSENT rollback rows and only exact-mode immutable release artifacts', () => {
    const fixture = createCapacityFixture();
    const mainSha = 'a'.repeat(40);
    try {
      const state = createRollbackManifest(fixture, `sha256:${'1'.repeat(64)}`, mainSha);
      const rollbackManifest = `farm-service\tsha256:${'1'.repeat(64)}\nfeed-service\tABSENT\n`;
      writeFileSync(state.manifest, rollbackManifest);
      writeFileSync(state.checksum, `${sha256(rollbackManifest)}\n`);
      writeFileSync(
        join(state.release, 'image-digests.tsv'),
        `farm-service\t${IMAGE_PREFIX}/farm-service\tsha256:${'2'.repeat(64)}\n`,
        { mode: 0o600 },
      );
      chmodSync(join(state.release, 'image-digests.tsv'), 0o644);
      writeFileSync(
        join(state.release, 'immutable-images.override.yml'),
        `services:\n  farm-service:\n    image: ${IMAGE_PREFIX}/farm-service@sha256:${'2'.repeat(64)}\n`,
        { mode: 0o600 },
      );
      const interruptedStage = join(state.release, '.image-digests.Ab12Cd.tmp');
      writeFileSync(interruptedStage, 'partial\n', { mode: 0o600 });

      const accepted = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(accepted.status).toBe(0);
      expect(combinedOutput(accepted)).toContain(
        `capacity_gc_release_authority=markerless-bootstrap sha=${mainSha}`,
      );
      expect(combinedOutput(accepted)).toContain(
        'rollback_state_release_entry_legacy_mode_converged',
      );
      expect(combinedOutput(accepted)).toContain('immutable_release_stage_recovered');
      expect(existsSync(interruptedStage)).toBe(false);
      expect(statSync(join(state.release, 'image-digests.tsv')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }

    const hostileFixture = createCapacityFixture();
    try {
      const state = createRollbackManifest(hostileFixture, `sha256:${'3'.repeat(64)}`, mainSha);
      const overridePath = join(state.release, 'immutable-images.override.yml');
      writeFileSync(overridePath, 'services: {}\n', { mode: 0o600 });
      chmodSync(overridePath, 0o640);

      const rejected = runCapacity(hostileFixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(rejected.status).not.toBe(0);
      expect(combinedOutput(rejected)).toContain('release retention file is unexpected or unsafe');
      expect(readFileSync(hostileFixture.dockerLog, 'utf8')).toBe('');
    } finally {
      rmSync(hostileFixture.root, { recursive: true, force: true });
    }
  });

  it('accepts an empty atomic rollback unit and recovers only safe interruption residue', () => {
    const fixture = createCapacityFixture();
    const mainSha = '7'.repeat(40);
    try {
      const state = createRollbackManifest(
        fixture,
        `sha256:${'7'.repeat(64)}`,
        mainSha,
        '20260718T120000Z',
        true,
      );
      const interruptedStage = join(state.release, '.rollback-state.Ab12Cd');
      mkdirSync(interruptedStage, { mode: 0o700 });
      writeFileSync(join(interruptedStage, 'rollback-images.tsv'), '', { mode: 0o600 });

      const recovered = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(recovered.status).toBe(0);
      expect(combinedOutput(recovered)).toContain('rollback_state_stage_recovered');
      expect(existsSync(interruptedStage)).toBe(false);
      expect(readFileSync(state.checksum, 'utf8')).toBe(`${sha256('')}\n`);
      const repeated = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(repeated.status).toBe(0);
      expect(combinedOutput(repeated)).toContain(
        `capacity_gc_release_authority=markerless-bootstrap-completed-replay sha=${mainSha}`,
      );
      expect(combinedOutput(repeated)).toContain('replay_mutation=false');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }

    const hostileFixture = createCapacityFixture();
    try {
      const state = createRollbackManifest(
        hostileFixture,
        `sha256:${'8'.repeat(64)}`,
        mainSha,
        '20260718T130000Z',
        true,
      );
      const hostileStage = join(state.release, '.rollback-state.Zz99Yy');
      mkdirSync(hostileStage, { mode: 0o700 });
      writeFileSync(join(hostileStage, 'foreign-state'), 'do-not-delete\n', { mode: 0o600 });

      const rejected = runCapacity(hostileFixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(rejected.status).not.toBe(0);
      expect(combinedOutput(rejected)).toContain('release rollback entry is unexpected');
      expect(existsSync(hostileStage)).toBe(true);
      expect(existsSync(join(hostileFixture.controlRoot, 'bootstrap-image-gc.json'))).toBe(false);
    } finally {
      rmSync(hostileFixture.root, { recursive: true, force: true });
    }
  });

  it('cuts exact legacy rollback state over atomically and rejects unsafe predecessor shapes', () => {
    const fixture = createCapacityFixture();
    const mainSha = '6'.repeat(40);
    try {
      const emptyRelease = join(fixture.controlRoot, 'releases', `${mainSha}-20260718T140000Z`);
      mkdirSync(emptyRelease, { mode: 0o700 });
      writeFileSync(join(emptyRelease, 'rollback-images.tsv'), '', { mode: 0o600 });

      const priorSha = '5'.repeat(40);
      const completeRelease = join(fixture.controlRoot, 'releases', `${priorSha}-20260718T130000Z`);
      mkdirSync(completeRelease, { mode: 0o755 });
      const completeManifest = `farm-service\tsha256:${'5'.repeat(64)}\n`;
      writeFileSync(join(completeRelease, 'rollback-images.tsv'), completeManifest, {
        mode: 0o644,
      });
      writeFileSync(
        join(completeRelease, 'rollback-images.sha256'),
        `${sha256(completeManifest)}\n`,
        { mode: 0o644 },
      );

      const recoveryState = createRollbackManifest(
        fixture,
        `sha256:${'2'.repeat(64)}`,
        '2'.repeat(40),
        '20260718T120000Z',
      );
      const recoveryManifest = readFileSync(recoveryState.manifest, 'utf8');
      writeFileSync(join(recoveryState.release, 'rollback-images.tsv'), recoveryManifest, {
        mode: 0o644,
      });
      writeFileSync(
        join(recoveryState.release, 'rollback-images.sha256'),
        `${sha256(recoveryManifest)}\n`,
        { mode: 0o644 },
      );

      const converted = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: emptyRelease,
      });
      expect(converted.status).toBe(0);
      expect(combinedOutput(converted)).toContain('rollback_state_legacy_cutover_completed');
      expect(combinedOutput(converted)).toContain('rollback_state_legacy_cutover_recovered');
      for (const [release, content] of [
        [emptyRelease, ''],
        [completeRelease, completeManifest],
        [recoveryState.release, recoveryManifest],
      ] as const) {
        const unit = join(release, 'rollback-state');
        expect(readdirSync(unit).sort()).toEqual(['rollback-images.sha256', 'rollback-images.tsv']);
        expect(readFileSync(join(unit, 'rollback-images.tsv'), 'utf8')).toBe(content);
        expect(readFileSync(join(unit, 'rollback-images.sha256'), 'utf8')).toBe(
          `${sha256(content)}\n`,
        );
        expect(existsSync(join(release, 'rollback-images.tsv'))).toBe(false);
        expect(existsSync(join(release, 'rollback-images.sha256'))).toBe(false);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }

    const scenarios: ReadonlyArray<{
      readonly arrange: (release: string) => void;
      readonly evidence: RegExp;
    }> = [
      {
        arrange: (release) => symlinkSync('/dev/null', join(release, 'rollback-images.tsv')),
        evidence: /release retention entry is unsafe/u,
      },
      {
        arrange: (release) => {
          const manifest = join(release, 'rollback-images.tsv');
          writeFileSync(manifest, '', { mode: 0o600 });
          chmodSync(manifest, 0o660);
        },
        evidence: /release retention file is unexpected or unsafe/u,
      },
      {
        arrange: (release) => {
          const content = `farm-service\tsha256:${'4'.repeat(64)}\n`;
          writeFileSync(join(release, 'rollback-images.tsv'), content, { mode: 0o600 });
          writeFileSync(join(release, 'rollback-images.sha256'), `${'0'.repeat(64)}\n`, {
            mode: 0o600,
          });
        },
        evidence: /legacy rollback checksum mismatch/u,
      },
      {
        arrange: (release) => {
          const content = 'farm-service\tnot-an-image\n';
          writeFileSync(join(release, 'rollback-images.tsv'), content, { mode: 0o600 });
          writeFileSync(join(release, 'rollback-images.sha256'), `${sha256(content)}\n`, {
            mode: 0o600,
          });
        },
        evidence: /legacy rollback manifest row is invalid/u,
      },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const hostile = createCapacityFixture();
      try {
        const release = join(
          hostile.controlRoot,
          'releases',
          `${mainSha}-20260718T15${String(index).padStart(2, '0')}00Z`,
        );
        mkdirSync(release, { mode: 0o700 });
        scenario.arrange(release);
        const rejected = runCapacity(hostile, 'gc', {
          DEPLOY_SHA: mainSha,
          DEPLOY_STATE_DIR: release,
        });
        expect(rejected.status).not.toBe(0);
        expect(combinedOutput(rejected)).toMatch(scenario.evidence);
        expect(existsSync(join(release, 'rollback-state'))).toBe(false);
        expect(existsSync(join(hostile.controlRoot, 'bootstrap-image-gc.json'))).toBe(false);
      } finally {
        rmSync(hostile.root, { recursive: true, force: true });
      }
    }
    const capacity = readFileSync(CAPACITY, 'utf8');
    expect(capacity).toContain('info.st_uid != expected_uid');
    expect(capacity).toContain('info.st_nlink != 1');
  });

  it('leaves markerless authority claimed after the first mutation boundary and denies retry', () => {
    const fixture = createCapacityFixture();
    const mainSha = '4'.repeat(40);
    const oldSha = '3'.repeat(40);
    const currentId = `sha256:${'4'.repeat(64)}`;
    const oldId = `sha256:${'3'.repeat(64)}`;
    const mutationMarker = join(fixture.root, 'mutation-crossed');
    try {
      const state = createRollbackManifest(fixture, currentId, mainSha);
      writeFileSync(
        fixture.inventory,
        [
          `${IMAGE_PREFIX}/farm-service\t${oldSha}\t${oldId}`,
          `${IMAGE_PREFIX}/farm-service\t${mainSha}\t${currentId}`,
        ].join('\n') + '\n',
      );
      const interrupted = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
        KILL_AFTER_RMI: 'true',
        MUTATION_MARKER: mutationMarker,
      });
      expect(interrupted.status).not.toBe(0);
      expect(existsSync(mutationMarker)).toBe(true);
      expect(readFileSync(fixture.dockerLog, 'utf8')).toContain(
        `rmi ${IMAGE_PREFIX}/farm-service:${oldSha}`,
      );
      expect(
        JSON.parse(readFileSync(join(fixture.controlRoot, 'bootstrap-image-gc.json'), 'utf8')),
      ).toEqual(expect.objectContaining({ incoming_sha: mainSha, state: 'CLAIMED' }));

      const logAtCrash = readFileSync(fixture.dockerLog, 'utf8');
      const retry = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: mainSha,
        DEPLOY_STATE_DIR: state.release,
      });
      expect(retry.status).not.toBe(0);
      expect(combinedOutput(retry)).toContain('capacity_gc_markerless_bootstrap_claim_incomplete');
      expect(readFileSync(fixture.dockerLog, 'utf8')).toBe(logAtCrash);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('executes markerless scheduled GC only from an exact published-source proof', () => {
    const fixture = createCapacityFixture();
    try {
      const proof = publishVerifiedCapacitySource(fixture);
      const releaseRoot = join(fixture.controlRoot, 'releases');
      rmSync(releaseRoot, { recursive: true });
      const proofEnv = {
        DEPLOY_STATE_DIR: '',
        PRODUCTION_HOST_MAIN_SHA: proof.mainSha,
        AQUA_PRODUCTION_SOURCE_ROOT: proof.sourceRoot,
        AQUA_PRODUCTION_SOURCE_DIR: proof.sourceDir,
      };
      const wrongSha = 'e'.repeat(40);
      const wrongShaResult = runCapacity(fixture, 'gc', {
        ...proofEnv,
        PRODUCTION_HOST_MAIN_SHA: wrongSha,
        AQUA_PRODUCTION_SOURCE_ROOT: join(fixture.controlRoot, 'sources', wrongSha),
        AQUA_PRODUCTION_SOURCE_DIR: join(fixture.controlRoot, 'sources', wrongSha, 'repository'),
      });
      expect(wrongShaResult.status).not.toBe(0);
      expect(combinedOutput(wrongShaResult)).toContain(
        'capacity_gc_bootstrap_source_proof_invalid',
      );

      const wrongPathResult = runCapacity(fixture, 'gc', {
        ...proofEnv,
        AQUA_PRODUCTION_SOURCE_ROOT: `${proof.sourceRoot}-attacker`,
      });
      expect(wrongPathResult.status).not.toBe(0);
      expect(combinedOutput(wrongPathResult)).toContain(
        'capacity_gc_bootstrap_source_path_invalid',
      );

      const trackedPath = join(proof.sourceDir, 'entrypoint.sh');
      const trackedContent = readFileSync(trackedPath, 'utf8');
      chmodSync(trackedPath, 0o755);
      writeFileSync(trackedPath, '#!/usr/bin/env bash\nexit 91\n');
      chmodSync(trackedPath, 0o555);
      const drifted = runCapacity(fixture, 'gc', proofEnv);
      expect(drifted.status).not.toBe(0);
      expect(combinedOutput(drifted)).toContain('capacity_gc_bootstrap_source_proof_invalid');
      chmodSync(trackedPath, 0o755);
      writeFileSync(trackedPath, trackedContent);
      chmodSync(trackedPath, 0o555);

      symlinkSync('/tmp', releaseRoot);
      const hostileReleaseRoot = runCapacity(fixture, 'gc', proofEnv);
      expect(hostileReleaseRoot.status).not.toBe(0);
      expect(combinedOutput(hostileReleaseRoot)).toContain('release root is not a real directory');
      rmSync(releaseRoot);

      const oldSha = 'd'.repeat(40);
      const oldId = `sha256:${'d'.repeat(64)}`;
      const incomingId = `sha256:${'e'.repeat(64)}`;
      writeFileSync(
        fixture.inventory,
        [
          `${IMAGE_PREFIX}/farm-service\t${oldSha}\t${oldId}`,
          `${IMAGE_PREFIX}/farm-service\t${proof.mainSha}\t${incomingId}`,
        ].join('\n') + '\n',
      );
      const accepted = runCapacity(fixture, 'gc', proofEnv);
      expect(accepted.status).toBe(0);
      expect(combinedOutput(accepted)).toContain(
        'rollback_state_inventory=empty reason=canonical_root_absent',
      );
      expect(combinedOutput(accepted)).toContain(
        `capacity_gc_release_authority=markerless-bootstrap sha=${proof.mainSha}`,
      );
      const dockerLog = readFileSync(fixture.dockerLog, 'utf8');
      expect(dockerLog).toContain(`rmi ${IMAGE_PREFIX}/farm-service:${oldSha}`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:${proof.mainSha}`);

      const firstAuthority = readFileSync(
        join(fixture.controlRoot, 'bootstrap-image-gc.json'),
        'utf8',
      );
      const descendant = publishDescendantCapacitySource(fixture, proof);
      const ancestry = readFileSync(
        join(descendant.sourceRoot, 'metadata/first-parent-ancestry.tsv'),
        'utf8',
      );
      const rolloverProof = sha256(ancestry);
      const rolloverEnv = {
        DEPLOY_STATE_DIR: '',
        PRODUCTION_HOST_MAIN_SHA: descendant.mainSha,
        AQUA_PRODUCTION_SOURCE_ROOT: descendant.sourceRoot,
        AQUA_PRODUCTION_SOURCE_DIR: descendant.sourceDir,
        AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED: 'true',
        AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA: proof.mainSha,
        AQUA_BOOTSTRAP_GC_PREDECESSOR_EPOCH: '1',
        AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256: '0'.repeat(64),
      };
      const tamperedRollover = runCapacity(fixture, 'gc', rolloverEnv);
      expect(tamperedRollover.status).not.toBe(0);
      expect(combinedOutput(tamperedRollover)).toContain(
        'capacity_gc_markerless_bootstrap_descendant_proof_mismatch',
      );
      expect(readFileSync(join(fixture.controlRoot, 'bootstrap-image-gc.json'), 'utf8')).toBe(
        firstAuthority,
      );

      writeFileSync(fixture.dockerLog, '');
      const rolled = runCapacity(fixture, 'gc', {
        ...rolloverEnv,
        AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256: rolloverProof,
      });
      expect(rolled.status).toBe(0);
      expect(combinedOutput(rolled)).toContain(
        `capacity_gc_release_authority=markerless-bootstrap-rollover predecessor=${proof.mainSha} sha=${descendant.mainSha}`,
      );
      expect(
        JSON.parse(readFileSync(join(fixture.controlRoot, 'bootstrap-image-gc.json'), 'utf8')),
      ).toEqual(
        expect.objectContaining({
          epoch: 2,
          incoming_sha: descendant.mainSha,
          predecessor_sha: proof.mainSha,
          state: 'COMPLETED',
          supersession_proof_sha256: rolloverProof,
        }),
      );
      expect(
        readFileSync(
          join(fixture.controlRoot, 'bootstrap-image-gc-history', `00000001-${proof.mainSha}.json`),
          'utf8',
        ),
      ).toBe(firstAuthority);

      const logAfterRollover = readFileSync(fixture.dockerLog, 'utf8');
      const replay = runCapacity(fixture, 'gc', {
        ...rolloverEnv,
        AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256: rolloverProof,
      });
      expect(replay.status).toBe(0);
      expect(combinedOutput(replay)).toContain(
        `markerless-bootstrap-completed-replay sha=${descendant.mainSha}`,
      );
      expect(readFileSync(fixture.dockerLog, 'utf8')).toBe(logAfterRollover);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('derives destructive release authority from the current marker, not an operator SHA', () => {
    const fixture = createCapacityFixture();
    const currentSha = 'd'.repeat(40);
    const historicalSha = 'e'.repeat(40);
    const currentId = `sha256:${'d'.repeat(64)}`;
    const historicalId = `sha256:${'e'.repeat(64)}`;
    try {
      const state = createRollbackManifest(fixture, currentId, currentSha);
      publishCurrentReleaseMarker(fixture, state.release, currentSha);
      writeFileSync(
        fixture.inventory,
        [
          `${IMAGE_PREFIX}/farm-service\t${currentSha}\t${currentId}`,
          `${IMAGE_PREFIX}/farm-service\t${historicalSha}\t${historicalId}`,
        ].join('\n') + '\n',
      );

      const result = runCapacity(fixture, 'gc', {
        DEPLOY_SHA: historicalSha,
        DEPLOY_STATE_DIR: state.release,
      });
      const output = combinedOutput(result);
      const dockerLog = readFileSync(fixture.dockerLog, 'utf8');
      expect({ status: result.status, output, dockerLog }).toEqual(
        expect.objectContaining({ status: 0 }),
      );
      expect(output).toContain(
        `capacity_gc_release_authority=current-release-marker sha=${currentSha}`,
      );
      expect(dockerLog).toContain(`rmi ${IMAGE_PREFIX}/farm-service:${historicalSha}`);
      expect(dockerLog).not.toContain(`rmi ${IMAGE_PREFIX}/farm-service:${currentSha}`);
      expect(existsSync(join(fixture.controlRoot, 'bootstrap-image-gc.json'))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('blocks image mutation before Docker GC when DR journal state is unresolved', () => {
    const fixture = createCapacityFixture();
    const mainSha = 'd'.repeat(40);
    try {
      const drRoot = join(fixture.controlRoot, 'dr-bootstrap');
      const execution = join(drRoot, `${mainSha}-1-1`);
      mkdirSync(execution, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(execution, 'phase.json'),
        `${JSON.stringify({
          candidate: {
            image_digest: `sha256:${'8'.repeat(64)}`,
            main_sha: mainSha,
            repository: 'Okan-wqm/aquaculture_platform',
            run_attempt: '1',
            run_id: '1',
          },
          candidate_image_id: `sha256:${'9'.repeat(64)}`,
          occurred_at: '2026-07-18T00:00:00Z',
          phase: 'FORWARD_RECREATED',
          prior_image_id: `sha256:${'a'.repeat(64)}`,
          schema_version: 1,
        })}\n`,
        { mode: 0o600 },
      );

      const result = runCapacity(fixture, 'gc');
      expect(result.status).not.toBe(0);
      expect(combinedOutput(result)).toContain('capacity_control_plane_dr_state_blocked');
      expect(readFileSync(fixture.dockerLog, 'utf8')).not.toMatch(/^rmi /m);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('denies active, uncertain, and raced host artifacts and unlinks only a stable inactive exact allowlist entry', () => {
    const fixture = createCapacityFixture();
    const harnessRoot = join(fixture.root, 'harness');
    const harnessCapacity = join(harnessRoot, 'scripts/deploy/droplet-capacity.sh');
    const harnessControl = join(harnessRoot, 'scripts/deploy/production-host-control-plane.sh');
    const harnessDeployPaths = join(harnessRoot, 'scripts/deploy/deploy-paths.sh');
    const candidate = join(fixture.root, 'swapfile-cleanup-20260610');
    const swapCounter = join(fixture.root, 'swapon.count');
    const unlinkLog = join(fixture.root, 'unlink.log');
    try {
      mkdirSync(dirname(harnessCapacity), { recursive: true });
      copyFileSync(fixture.controlPlaneScript, harnessControl);
      chmodSync(harnessControl, 0o755);
      copyFileSync(DEPLOY_PATHS, harnessDeployPaths);
      mkdirSync(join(harnessRoot, 'infrastructure/deploy'), { recursive: true });
      copyFileSync(
        SERVICE_CATALOG,
        join(harnessRoot, 'infrastructure/deploy/service-catalog.deploy.vars'),
      );
      const source = readFileSync(CAPACITY, 'utf8').replaceAll(
        '/swapfile-cleanup-20260610',
        candidate,
      );
      writeFileSync(harnessCapacity, source, { mode: 0o755 });
      writeFileSync(candidate, '');
      truncateSync(candidate, 6 * 1024 * 1024 * 1024);
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      utimesSync(candidate, old, old);
      executable(
        join(fixture.fakeBin, 'stat'),
        `#!/usr/bin/env bash
set -euo pipefail
target="\${!#}"
if [ "\${target}" = "\${CANDIDATE_PATH}" ] && [ "\${FAIL_CANDIDATE_STAT:-false}" = true ]; then exit 55; fi
exec /usr/bin/stat "$@"
`,
      );
      executable(
        join(fixture.fakeBin, 'findmnt'),
        `#!/usr/bin/env bash
set -euo pipefail
case "\${FINDMNT_MODE:-inactive}" in
  inactive) printf '{"filesystems":[{"target":"/","source":"overlay"}]}\\n' ;;
  target) printf '{"filesystems":[{"target":"%s","source":"overlay"}]}\\n' "\${CANDIDATE_PATH}" ;;
  source) printf '{"filesystems":[{"target":"/mnt/probe","source":"%s"}]}\\n' "\${CANDIDATE_PATH}" ;;
  error) exit 1 ;;
  malformed) printf '{not-json}\\n' ;;
  *) exit 64 ;;
esac
`,
      );
      executable(
        join(fixture.fakeBin, 'losetup'),
        `#!/usr/bin/env bash
set -euo pipefail
case "\${LOSETUP_MODE:-inactive}" in
  inactive) printf '{"loopdevices":[]}\\n' ;;
  active) printf '{"loopdevices":[{"name":"/dev/loop7","back-file":"%s"}]}\\n' "\${CANDIDATE_PATH}" ;;
  error) exit 1 ;;
  malformed) printf '{not-json}\\n' ;;
  *) exit 64 ;;
esac
`,
      );
      executable(
        join(fixture.fakeBin, 'fuser'),
        `#!/usr/bin/env bash
set -euo pipefail
target="\${!#}"
case "\${FUSER_MODE:-inactive}" in
  inactive)
    printf '%s' "\${PPID}"
    printf '%s:\n' "\${target}" >&2
    ;;
  active)
    printf '%s %s' "\${PPID}" 999999
    printf '%s:\n' "\${target}" >&2
    ;;
  error) printf 'synthetic fuser failure\n' >&2; exit 1 ;;
  malformed) printf 'not-a-pid'; printf '%s:\n' "\${target}" >&2 ;;
  *) exit 64 ;;
esac
`,
      );
      executable(
        join(fixture.fakeBin, 'swapon'),
        `#!/usr/bin/env bash
set -euo pipefail
count=0
[ ! -f "\${SWAPON_COUNTER}" ] || count="$(cat "\${SWAPON_COUNTER}")"
count=$((count + 1))
printf '%s\n' "\${count}" > "\${SWAPON_COUNTER}"
case "\${SWAPON_MODE:-never}" in
  always) printf '%s\n' "\${CANDIDATE_PATH}" ;;
  second) [ "\${count}" -lt 2 ] || printf '%s\n' "\${CANDIDATE_PATH}" ;;
  never) ;;
  *) exit 64 ;;
esac
`,
      );
      executable(
        join(fixture.fakeBin, 'unlink'),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${UNLINK_LOG}"
exec /usr/bin/unlink "$@"
`,
      );
      const common = {
        CANDIDATE_PATH: candidate,
        FINDMNT_MODE: 'inactive',
        FUSER_MODE: 'inactive',
        LOSETUP_MODE: 'inactive',
        SWAPON_COUNTER: swapCounter,
        UNLINK_LOG: unlinkLog,
      };

      const dryRun = runCapacity(
        fixture,
        'host-artifact-gc-dry-run',
        {
          ...common,
          HOST_ARTIFACT_GC_DRY_RUN: 'false',
          SWAPON_MODE: 'never',
        },
        harnessCapacity,
      );
      expect({ status: dryRun.status, output: combinedOutput(dryRun) }).toEqual(
        expect.objectContaining({ status: 0 }),
      );
      expect(combinedOutput(dryRun)).toContain('removed=0 already_absent=0 dry_run=1 blocked=0');
      expect(combinedOutput(dryRun)).toContain('predicate=unlink result=dry_run');
      expect(existsSync(candidate)).toBe(true);
      expect(existsSync(unlinkLog)).toBe(false);

      for (const denial of [
        { environment: { FINDMNT_MODE: 'error' }, evidence: 'findmnt_inventory_failed' },
        { environment: { FINDMNT_MODE: 'malformed' }, evidence: 'findmnt_inventory_invalid' },
        { environment: { FINDMNT_MODE: 'target' }, evidence: 'preflight_not_mountpoint' },
        { environment: { FINDMNT_MODE: 'source' }, evidence: 'preflight_not_mount_source' },
        { environment: { LOSETUP_MODE: 'error' }, evidence: 'losetup_inventory_failed' },
        { environment: { LOSETUP_MODE: 'active' }, evidence: 'preflight_not_loop_backing' },
        { environment: { FUSER_MODE: 'error' }, evidence: 'candidate_fuser_evidence_invalid' },
        { environment: { FUSER_MODE: 'active' }, evidence: 'candidate_fuser_evidence_invalid' },
        { environment: { FUSER_MODE: 'malformed' }, evidence: 'candidate_fuser_evidence_invalid' },
      ]) {
        rmSync(swapCounter, { force: true });
        const denied = runCapacity(
          fixture,
          'host-artifact-gc-dry-run',
          { ...common, ...denial.environment, SWAPON_MODE: 'never' },
          harnessCapacity,
        );
        expect(denied.status).not.toBe(0);
        expect(combinedOutput(denied)).toContain(denial.evidence);
        expect(existsSync(candidate)).toBe(true);
        expect(existsSync(unlinkLog)).toBe(false);
      }

      rmSync(swapCounter, { force: true });
      const dryRunActive = runCapacity(
        fixture,
        'host-artifact-gc-dry-run',
        {
          ...common,
          HOST_ARTIFACT_GC_DRY_RUN: 'false',
          SWAPON_MODE: 'always',
        },
        harnessCapacity,
      );
      expect(dryRunActive.status).not.toBe(0);
      expect(combinedOutput(dryRunActive)).toContain('preflight_not_active_swap');
      expect(existsSync(candidate)).toBe(true);
      expect(existsSync(unlinkLog)).toBe(false);

      rmSync(swapCounter, { force: true });
      const active = runCapacity(
        fixture,
        'host-artifact-gc',
        { ...common, SWAPON_MODE: 'always' },
        harnessCapacity,
      );
      expect(active.status).not.toBe(0);
      expect(combinedOutput(active)).toContain('preflight_not_active_swap');
      expect(existsSync(candidate)).toBe(true);
      expect(existsSync(unlinkLog)).toBe(false);

      rmSync(swapCounter, { force: true });
      const uncertain = runCapacity(
        fixture,
        'host-artifact-gc',
        { ...common, FAIL_CANDIDATE_STAT: 'true', SWAPON_MODE: 'never' },
        harnessCapacity,
      );
      expect(uncertain.status).not.toBe(0);
      expect(combinedOutput(uncertain)).toContain('predicate=initial_stat');
      expect(combinedOutput(uncertain)).toContain('reason=stat_failed');
      expect(existsSync(unlinkLog)).toBe(false);

      rmSync(swapCounter, { force: true });
      const raced = runCapacity(
        fixture,
        'host-artifact-gc',
        { ...common, SWAPON_MODE: 'second' },
        harnessCapacity,
      );
      expect(raced.status).not.toBe(0);
      expect(combinedOutput(raced)).toContain('preunlink_not_active_swap');
      expect(existsSync(candidate)).toBe(true);
      expect(existsSync(unlinkLog)).toBe(false);

      rmSync(swapCounter, { force: true });
      const removed = runCapacity(
        fixture,
        'host-artifact-gc',
        {
          ...common,
          HOST_ARTIFACT_GC_DRY_RUN: 'true',
          SWAPON_MODE: 'never',
        },
        harnessCapacity,
      );
      expect(removed.status).toBe(0);
      expect(combinedOutput(removed)).toContain('removed=1');
      expect(existsSync(candidate)).toBe(false);
      expect(readFileSync(unlinkLog, 'utf8')).toContain(candidate);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
