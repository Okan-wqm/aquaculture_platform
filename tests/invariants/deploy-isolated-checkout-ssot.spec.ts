import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function executableShell(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

function deployImageManifestProgram(script: string): string {
  const match = script.match(/<<'DEPLOY_IMAGE_MANIFEST_PY'\n([\s\S]*?)\nDEPLOY_IMAGE_MANIFEST_PY/u);
  const program = match?.[1];
  if (program === undefined) {
    throw new Error('deploy image digest manifest validator is missing');
  }
  return program;
}

/**
 * SSoT contract for production source material.
 *
 * Production used to fetch objects and materialize a Git worktree on the
 * target host. That made mutable target-host remotes, config and object state
 * part of the release authority. The replacement is a runner-produced archive
 * of an exact protected-main commit, verified and atomically published under a
 * host-global lock. The target never needs a Git repository.
 */
describe('production exact-SHA runtime bundle SSOT', () => {
  const paths = read('scripts/deploy/deploy-paths.sh');
  const hostControl = read('scripts/deploy/production-host-control-plane.sh');
  const bundleProducer = read('tools/scripts/ci/prepare-production-host-runtime-bundle.sh');
  const payloadProducer = read('tools/scripts/ci/prepare-production-host-ssh-payload.sh');
  const protectedSsh = read('tools/scripts/ci/run-protected-ssh.sh');
  const deploy = read('scripts/deploy/droplet-up.sh');
  const verify = read('scripts/deploy/post-deploy-verify.sh');
  const compose = read('docker-compose.droplet.yml');
  const certificateGenerator = read('infrastructure/docker/scripts/generate-internal-certs.sh');
  const deployWorkflow = read('.github/workflows/deploy-digitalocean.yml');
  const capacityWorkflow = read('.github/workflows/deploy-capacity-maintenance.yml');
  const verifyWorkflow = read('.github/workflows/production-post-deploy-verify.yml');

  it('keeps the host lock and immutable source root in one control-plane SSoT', () => {
    expect(hostControl).toContain('AQUA_PRODUCTION_CONTROL_ROOT_DEFAULT=/var/lib/aqua/deploy');
    expect(hostControl).toContain('AQUA_PRODUCTION_CONTROL_LOCK_NAME=control-plane.lock');
    expect(hostControl).toContain('AQUA_CONTROL_PLANE_SOURCES_ROOT=');
    expect(hostControl).toContain('aqua_control_plane_lock_acquire');
    expect(hostControl).toContain('aqua_control_plane_lock_assert');
    expect(hostControl).toContain('aqua_control_plane_guard_dr_state');
    expect(hostControl).toContain('AQUA_CONTROL_PLANE_LOCK_FD');

    for (const consumer of [paths, deploy, verify]) {
      expect(consumer).not.toContain('/var/lib/aqua/deploy/control-plane.lock');
    }
  });

  it('builds from the exact commit object, independent of dirty worktree and mutable Git config', () => {
    const exec = executableShell(bundleProducer);

    expect(exec).toContain('SOURCE_SHA');
    expect(exec).toContain('git archive');
    expect(exec).toContain('--no-replace-objects');
    expect(exec).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(exec).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(exec).toContain('protocol.allow=never');
    expect(exec).toContain('gzip --no-name');
    expect(bundleProducer).toContain('metadata/manifest.json');
    expect(bundleProducer).toContain('metadata/tracked-tree.tsv');
    expect(bundleProducer).toContain('migration_manifest_hash');
    expect(bundleProducer).toContain('nats_config_hash');
    expect(bundleProducer).toContain('runtime/check-service-health.mjs');
    expect(bundleProducer).toContain('runtime/assert-service-signals.mjs');
  });

  it('verifies archive shape and content before an atomic immutable publish', () => {
    expect(hostControl).toContain('PRODUCTION_HOST_BUNDLE_SHA256');
    expect(hostControl).toContain('PRODUCTION_HOST_MAIN_SHA');
    expect(hostControl).toContain('tracked_tree_manifest_hash');
    expect(hostControl).toContain('aqua_control_plane_publish_bundle');
    expect(hostControl).toContain('lock-exec');
    expect(hostControl).toContain('shared-exec');
    expect(hostControl).toMatch(/\.\.[/\\]/);
    expect(hostControl).toMatch(/unexpected/iu);
    expect(hostControl).toContain('symlink');
    expect(hostControl).toContain('sha256sum');
    expect(hostControl).toContain('mv');
  });

  it('uses the protected native SSH helper and a runtime payload in every production lane', () => {
    for (const workflow of [capacityWorkflow, deployWorkflow, verifyWorkflow]) {
      expect(workflow).toContain('DROPLET_SSH_FINGERPRINT');
      expect(workflow).toContain('tools/scripts/ci/run-protected-ssh.sh');
      expect(workflow).toContain('prepare-production-host-ssh-payload.sh');
      expect(workflow).toContain('/usr/bin/git --no-replace-objects');
      expect(workflow).not.toContain('appleboy/ssh-action@');
      expect(workflow).not.toContain('StrictHostKeyChecking=accept-new');
    }
    expect(protectedSsh).toContain('StrictHostKeyChecking=yes');
    expect(protectedSsh).toContain('/usr/bin/env -i');
    expect(payloadProducer).toContain('production-host-control-plane.sh');
    expect(payloadProducer).toContain('base64');
    expect(payloadProducer).toContain('remote env name is not approved');
    expect(payloadProducer).toContain('unset BASH_ENV ENV');
    const envRemoval = payloadProducer.indexOf('/usr/bin/rm -f -- "\\${ENV_PATH}"');
    const argvRemoval = payloadProducer.indexOf('/usr/bin/rm -f -- "\\${ARGV_PATH}"');
    const finalExport = payloadProducer.indexOf('export "\\${name}"');
    const controlHandoff = payloadProducer.indexOf('/bin/bash "\\${CONTROL_HELPER}"');
    expect(envRemoval).toBeGreaterThan(0);
    expect(argvRemoval).toBeGreaterThan(envRemoval);
    expect(finalExport).toBeGreaterThan(argvRemoval);
    expect(controlHandoff).toBeGreaterThan(finalExport);
    const remoteCleanup = payloadProducer.slice(
      payloadProducer.indexOf('cleanup() {'),
      payloadProducer.indexOf('trap cleanup EXIT'),
    );
    expect(remoteCleanup.indexOf('clear_remote_environment')).toBeLessThan(
      remoteCleanup.indexOf('/usr/bin/rm -rf'),
    );
  });

  it('contains no target-host Git authority in runtime or workflow SSH surfaces', () => {
    const targetRuntime = executableShell([paths, hostControl, deploy, verify].join('\n'));

    expect(targetRuntime).not.toMatch(
      /\bgit\s+(fetch|checkout|show|worktree|rev-parse|ls-files)\b/,
    );
    expect(targetRuntime).not.toContain('/var/aqua-saas/.git');
    expect(deployWorkflow).not.toContain('git show "${DEPLOY_SHA}:scripts/deploy/deploy-paths.sh"');
    expect(capacityWorkflow).not.toContain('git checkout -f "${TARGET_SHA}"');
  });

  it('keeps secrets outside the immutable source and removes mutable node_modules authority', () => {
    expect(paths).toContain('DEPLOY_ENV_FILE');
    expect(paths).toContain('DEPLOY_CERTS_DIR');
    expect(paths).toContain('COMPOSE_ENV_FILES');
    expect(deploy).toContain('runtime/check-service-health.mjs');
    expect(deploy).toContain('runtime/assert-service-signals.mjs');
    expect(deploy).not.toContain('/var/aqua-saas/node_modules');
    expect(paths).not.toContain('ln -sfn "${src}/node_modules"');
    expect(certificateGenerator).toContain('DEPLOY_CERTS_DIR');
    expect(compose).toContain('${DEPLOY_CERTS_DIR:-./certs}');
  });

  it('verifies the published source marker instead of a target Git HEAD', () => {
    expect(paths).toContain('aqua_control_plane_verify_source');
    expect(verify).toContain('aqua_control_plane_verify_source');
    expect(verify).not.toContain('git rev-parse HEAD');
    expect(verify).not.toContain('require_command git');
    expect(verify).toContain('TARGET_SHA');
    expect(paths).toContain('publish_deploy_current_release');
    expect(paths).toContain('assert_deploy_current_release');
    expect(verify).toContain('Full release-ledger image parity for current release');
    expect(verify).toContain('Selective registry-digest manifest parity for current release');
    expect(verify).toContain('current_release_marker_match');
  });

  it('preserves rollback, health, boot-signal, and public HTTPS gates', () => {
    expect(deploy).toContain('rollback_and_record');
    expect(deploy).toContain('runtime/check-service-health.mjs');
    expect(deploy).toContain('runtime/assert-service-signals.mjs');
    expect(deploy).toContain('Public /graphql smoke through nginx');
    expect(deploy).toContain('https://${SMOKE_HOST}');
  });

  it('generates missing certificates but fails closed on production rotation', () => {
    const certificateBlock = deploy.slice(
      deploy.indexOf('CERT_RENEW=false'),
      deploy.indexOf('# ADR-016 Phase A'),
    );

    expect(certificateBlock).toContain('record_no_state_changed_failure "tls_rotation_required"');
    expect(certificateBlock).toContain(
      'bash infrastructure/docker/scripts/generate-internal-certs.sh',
    );
    expect(certificateBlock).not.toContain('generate-internal-certs.sh --force');
    expect(certificateGenerator).toContain(
      '[ "${FORCE}" = true ] && [ -n "${DEPLOY_CERTS_DIR:-}" ]',
    );
  });

  it('fails closed unless the decoded image manifest exactly matches the deploy selection', () => {
    const program = deployImageManifestProgram(deploy);
    const root = mkdtempSync(join(tmpdir(), 'aqua-deploy-image-manifest-'));
    const destination = join(root, 'image-digests.tsv');
    const overrideDestination = join(root, 'immutable-images.override.yml');
    chmodSync(root, 0o700);
    const prefix = 'ghcr.io/okan-wqm/aquaculture_platform';
    const digest = (character: string): string => `sha256:${character.repeat(64)}`;
    const validText = [
      `gateway-api\t${prefix}/gateway-api\t${digest('a')}`,
      `db-migrate\t${prefix}/db-migrate\t${digest('b')}`,
      '',
    ].join('\n');
    const run = (text: string, encoded?: string): ReturnType<typeof spawnSync> =>
      spawnSync(
        '/usr/bin/python3',
        [
          '-c',
          program,
          destination,
          overrideDestination,
          'gateway-api db-migrate farm-service',
          'gateway-api db-migrate',
          prefix,
          'gateway-api:gateway-api db-migrate:db-migrate tenant-schema-provisioner:db-migrate farm-service:farm-service',
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            DEPLOY_IMAGE_DIGESTS_B64: encoded ?? Buffer.from(text).toString('base64'),
          },
        },
      );
    try {
      expect(run(validText).status).toBe(0);
      expect(readFileSync(destination, 'utf8')).toBe(validText);
      expect(readFileSync(overrideDestination, 'utf8')).toBe(
        `services:\n  gateway-api:\n    image: ${prefix}/gateway-api@${digest('a')}\n` +
          `  db-migrate:\n    image: ${prefix}/db-migrate@${digest('b')}\n` +
          `  tenant-schema-provisioner:\n    image: ${prefix}/db-migrate@${digest('b')}\n`,
      );
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      expect(statSync(overrideDestination).mode & 0o777).toBe(0o600);
      for (const invalid of [
        `gateway-api\t${prefix}/gateway-api\t${digest('a')}\n`,
        `${validText}gateway-api\t${prefix}/gateway-api\t${digest('a')}\n`,
        `db-migrate\t${prefix}/db-migrate\t${digest('b')}\n` +
          `gateway-api\t${prefix}/gateway-api\t${digest('a')}\n`,
        `gateway-api\t${prefix}/farm-service\t${digest('a')}\n` +
          `db-migrate\t${prefix}/db-migrate\t${digest('b')}\n`,
        `gateway-api\t${prefix}/gateway-api\tsha256:short\n` +
          `db-migrate\t${prefix}/db-migrate\t${digest('b')}\n`,
      ]) {
        expect(run(invalid).status).not.toBe(0);
        expect(readFileSync(destination, 'utf8')).toBe(validText);
        expect(readFileSync(overrideDestination, 'utf8')).toContain(
          `${prefix}/gateway-api@${digest('a')}`,
        );
      }
      expect(run('', 'not-base64!').status).not.toBe(0);
      expect(readFileSync(destination, 'utf8')).toBe(validText);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the compose SHA tag fail-closed before accepting a pulled image', () => {
    const pullBlock = deploy.slice(
      deploy.indexOf('pull_deploy_image_required()'),
      deploy.indexOf('capture_rollback_manifest()'),
    );

    expect(pullBlock).toContain('if ! docker tag "${immutable_ref}" "${deploy_tag_ref}"; then');
    expect(pullBlock).toContain('image_deploy_tag_pin');
    expect(pullBlock).toContain('[ "${deploy_tag_image_id}" != "${immutable_image_id}" ]');
    expect(pullBlock).not.toMatch(
      /docker tag "\$\{immutable_ref\}" "\$\{deploy_tag_ref\}"[^\n]*\|\| true/u,
    );
  });

  it('creates candidate containers through the exact digest override and excludes it from rollback', () => {
    const deployComposeStart = deploy.indexOf('deploy_compose()');
    const rollbackComposeStart = deploy.indexOf('rollback_compose()', deployComposeStart);
    const cleanupStart = deploy.indexOf(
      'remove_canonical_project_containers_after_down()',
      rollbackComposeStart,
    );
    const deployCompose = deploy.slice(deployComposeStart, rollbackComposeStart);
    const rollbackCompose = deploy.slice(rollbackComposeStart, cleanupStart);
    expect(deployCompose).toContain('-f "${DEPLOY_COMPOSE_OVERRIDE_FILE}"');
    expect(deployCompose).toContain('assert_deploy_compose_override');
    expect(rollbackCompose).toContain('docker compose -f docker-compose.droplet.yml');
    expect(rollbackCompose).not.toContain('DEPLOY_COMPOSE_OVERRIDE_FILE');
    expect(deploy).toContain('timeout --kill-after=30s "${DB_MIGRATE_TIMEOUT_SECONDS}s"');
    expect(deploy).toContain('deploy_compose up -d --no-build 2>&1');
    expect(deploy).toContain('Live container image does not match the immutable manifest');
  });

  it('publishes empty and nonempty rollback manifest/checksum pairs as one atomic unit', () => {
    const functionStart = deploy.indexOf('capture_rollback_manifest()');
    const functionEnd = deploy.indexOf('rollback_deployed_services()', functionStart);
    expect(functionStart).toBeGreaterThan(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const captureFunction = deploy.slice(functionStart, functionEnd);
    const root = mkdtempSync(join(tmpdir(), 'aqua-rollback-unit-'));
    const runCapture = (releaseName: string, withContainer: boolean, running = true) => {
      const release = join(root, releaseName);
      mkdirSync(release, { mode: 0o700 });
      const harness = `
set -euo pipefail
APPLICATION_COMPOSE_IMAGE_MAP='${withContainer ? 'farm-service:farm-service db-migrate:db-migrate' : 'db-migrate:db-migrate'}'
DEPLOY_STATE_DIR=${JSON.stringify(release)}
ROLLBACK_STATE_DIR="\${DEPLOY_STATE_DIR}/rollback-state"
ROLLBACK_MANIFEST="\${ROLLBACK_STATE_DIR}/rollback-images.tsv"
ROLLBACK_CHECKSUM="\${ROLLBACK_STATE_DIR}/rollback-images.sha256"
IMAGE_PREFIX='ghcr.io/okan-wqm/aquaculture_platform'
DEPLOY_RELEASE_ID=${JSON.stringify(releaseName)}
WITH_CONTAINER=${withContainer ? 'true' : 'false'}
CONTAINER_RUNNING=${running ? 'true' : 'false'}
COMPOSE_PROJECT_NAME='aqua-saas'
application_compose_services() {
  [ "\${WITH_CONTAINER}" = true ] && printf 'farm-service\\n'
  printf 'db-migrate\\n'
}
rollback_compose() { docker compose -f docker-compose.droplet.yml "$@"; }
docker() {
  if [ "\${1:-}:\${2:-}" = 'compose:-f' ]; then
    if [ "\${WITH_CONTAINER}" = true ] && [[ " $* " = *' ps --all --quiet farm-service '* ]]; then
      printf '%s\\n' '${'1'.repeat(64)}'
    fi
    return 0
  fi
  if [ "\${1:-}" = inspect ]; then
    printf 'sha256:${'a'.repeat(64)}|%s|healthy|0|aqua-saas|farm-service\\n' "\${CONTAINER_RUNNING}"
    return 0
  fi
  [ "\${1:-}" = tag ] && return 0
  return 64
}
${captureFunction}
capture_rollback_manifest
`;
      return {
        release,
        result: spawnSync('/bin/bash', ['-c', harness], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        }),
      };
    };

    try {
      for (const [name, withContainer] of [
        ['nonempty', true],
        ['empty', false],
      ] as const) {
        const { release, result } = runCapture(name, withContainer);
        expect(result.status).toBe(0);
        const unit = join(release, 'rollback-state');
        const manifest = join(unit, 'rollback-images.tsv');
        const checksum = join(unit, 'rollback-images.sha256');
        expect(readdirSync(unit).sort()).toEqual(['rollback-images.sha256', 'rollback-images.tsv']);
        expect(existsSync(manifest)).toBe(true);
        expect(existsSync(checksum)).toBe(true);
        const content = readFileSync(manifest, 'utf8');
        expect(readFileSync(checksum, 'utf8')).toBe(
          `${createHash('sha256').update(content).digest('hex')}\n`,
        );
        expect(content === '').toBe(!withContainer);
        expect(
          readdirSync(release).filter((entry) => entry.startsWith('.rollback-state.')),
        ).toEqual([]);
      }
      expect(captureFunction).toContain('mv -T -- "${rollback_stage_dir}" "${ROLLBACK_STATE_DIR}"');
      expect(captureFunction).toContain("trap 'exit 143' TERM");
      const stopped = runCapture('stopped', true, false);
      expect(stopped.result.status).not.toBe(0);
      expect(`${stopped.result.stdout}${stopped.result.stderr}`).toContain(
        'farm-service is not a valid rollback point',
      );
      expect(existsSync(join(stopped.release, 'rollback-state'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
