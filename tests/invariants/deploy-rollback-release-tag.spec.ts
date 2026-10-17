/**
 * INFRA-HIGH-230 — a deploy rollback never moves a release tag, and never
 * restores an image that booted before the current schema.
 *
 * CI - Affected run 38990686731 (deploy-development/deploy, ffd6aa2f4),
 * 2026-10-17:
 *   attempt 3  db-migrate applied 2 migrations; compose failed; the rollback
 *              guard refused (count 2).
 *   attempt 4  db-migrate applied 0 (attempt 3 already had); compose failed
 *              again; the guard, which only saw this attempt's count, passed.
 *              `rollback_deployed_services` then ran
 *              `docker tag <pre-release id> <svc>:latest` and
 *              `docker tag <pre-release id> <svc>:ffd6aa2f4...` for every app
 *              service and its own `compose up` failed. Result: shell:ffd6aa2f4
 *              -> ebc6d366dea1 (the pre-release image), the pulled release
 *              image untagged, and any later `TAG=ffd6aa2f4 docker compose up`
 *              silently started old code against a forward-migrated schema.
 *
 * The specs below source the rollback library against a fake Docker daemon
 * and assert the Docker side effects of each attempt.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createFakeDeployDocker, type FakeDockerFixture } from './helpers/fake-deploy-docker';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PREFIX = 'ghcr.io/example/aqua';
const PROJECT = 'aqua-saas';
const DEPLOY_SHA = 'ffd6aa2f4b7ac0668a65e3ef41ea2bd845743281';
const RELEASE_ID = `${DEPLOY_SHA}-20261017T085545Z`;
const ROLLBACK_TAG = `rollback-${RELEASE_ID}`;
/** Attempt 3 finished db-migrate at 08:38:24Z and recorded it in the ledger. */
const SCHEMA_ADVANCED_AT = Date.parse('2026-10-17T08:38:24Z') / 1000;

interface ServiceSpec {
  service: string;
  containerName: string;
  containerId: string;
  preReleaseImage: string;
  releaseImage: string;
}

const SERVICES: readonly ServiceSpec[] = [
  {
    service: 'shell',
    containerName: 'aqua-shell',
    containerId: `6b179cd44690${'1'.repeat(52)}`,
    preReleaseImage: `sha256:ebc6d366dea1${'0'.repeat(52)}`,
    releaseImage: `sha256:e2dcd102bd52${'0'.repeat(52)}`,
  },
  {
    service: 'dashboard',
    containerName: 'aqua-dashboard',
    containerId: `7d7f4e41431e${'2'.repeat(52)}`,
    preReleaseImage: `sha256:275d4cd49d55${'0'.repeat(52)}`,
    releaseImage: `sha256:e7183bbb317d${'0'.repeat(52)}`,
  },
];

function seed(fixture: FakeDockerFixture, startedAt: string): void {
  fixture.writeComposeConfig(
    PROJECT,
    Object.fromEntries(SERVICES.map((spec) => [spec.service, spec.containerName])),
  );
  fixture.setRunningNames(['aqua-postgres', ...SERVICES.map((spec) => spec.containerName)]);
  fixture.setPsqlOutput(`${SCHEMA_ADVANCED_AT}\n`);
  fixture.setDbMigrateExit('false', '0', '2026-10-17T08:57:38Z');
  for (const spec of SERVICES) {
    fixture.addContainer({
      id: spec.containerId,
      name: spec.containerName,
      state: 'running',
      project: PROJECT,
      service: spec.service,
      startedAt,
      image: spec.preReleaseImage,
    });
    fixture.setComposePs(spec.service, spec.containerId);
    // The release images were pulled by digest and pinned to the release tags.
    fixture.setImage(`${PREFIX}/${spec.service}:${DEPLOY_SHA}`, spec.releaseImage);
    fixture.setImage(`${PREFIX}/${spec.service}:latest`, spec.releaseImage);
  }
}

function runAttempt(
  fixture: FakeDockerFixture,
  migrationsApplied: string,
  extraScript = '',
): SpawnSyncReturns<string> {
  const services = SERVICES.map((spec) => spec.service).join(' ');
  return spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        'source scripts/deploy/lib/deployment-mode-policy.sh',
        'source scripts/deploy/lib/compose-recreate.sh',
        'source scripts/deploy/lib/release-rollback.sh',
        'capture_rollback_manifest',
        extraScript,
        `MIGRATIONS_APPLIED_THIS_RELEASE=${migrationsApplied}`,
        'rollback_deployed_services service_recreate',
      ]
        .filter(Boolean)
        .join('\n'),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        FAKE_DOCKER_STATE: fixture.state,
        IMAGE_PREFIX: PREFIX,
        DEPLOY_SHA,
        TAG: DEPLOY_SHA,
        DEPLOY_RELEASE_ID: RELEASE_ID,
        ROLLBACK_MANIFEST: join(fixture.root, 'rollback-images.tsv'),
        DEPLOY_STATE_DIR: fixture.root,
        APPLICATION_IMAGE_SERVICES: services,
        DEPLOY_SERVICES: services,
        SHARED_IMAGE_RESTART_SERVICES: '',
        INFRA_IMAGE_SERVICES: '',
        FULL_DEPLOY: 'false',
        PRESERVE_DATA_INFRASTRUCTURE: 'true',
        COMPOSE_PROJECT_NAME: PROJECT,
      },
    },
  );
}

/** `docker tag` calls whose destination is a release tag (`:<sha>` or `:latest`). */
function releaseTagWrites(fixture: FakeDockerFixture): string[] {
  return fixture.invocations().filter((line) => /\ttag \S+ \S+:(latest|[0-9a-f]{40})$/.test(line));
}

function composeUps(fixture: FakeDockerFixture): string[] {
  return fixture.invocations().filter((line) => /\tcompose .*\bup\b/.test(line));
}

function expectReleaseTagsOnReleaseImages(fixture: FakeDockerFixture): void {
  for (const spec of SERVICES) {
    expect(fixture.imageOf(`${PREFIX}/${spec.service}:${DEPLOY_SHA}`)).toBe(spec.releaseImage);
    expect(fixture.imageOf(`${PREFIX}/${spec.service}:latest`)).toBe(spec.releaseImage);
  }
}

describe('deploy rollback keeps release tags on the release (INFRA-HIGH-230)', () => {
  let fixture: FakeDockerFixture;

  afterEach(() => {
    fixture.cleanup();
  });

  it('attempt 4: refuses to restore containers that booted before an earlier attempt migrated', () => {
    fixture = createFakeDeployDocker();
    // The pre-release containers booted days before attempt 3 migrated.
    seed(fixture, '2026-10-10T06:00:00.123456789Z');

    const result = runAttempt(fixture, '0');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('booted before the latest schema advance');
    expect(output).toContain('Rollback refused');
    expect(readFileSync(join(fixture.root, 'rollback-images.tsv'), 'utf8')).toBe('');
    expect(releaseTagWrites(fixture)).toEqual([]);
    expect(composeUps(fixture)).toEqual([]);
    expectReleaseTagsOnReleaseImages(fixture);
  });

  it('attempt 3: a release that applied migrations is refused without touching any tag or container', () => {
    fixture = createFakeDeployDocker();
    // Booted after the last recorded advance: valid rollback points.
    seed(fixture, '2026-10-17T08:50:00Z');

    const result = runAttempt(fixture, '2');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('applied 2 database migration(s)');
    expect(releaseTagWrites(fixture)).toEqual([]);
    expect(composeUps(fixture)).toEqual([]);
    expectReleaseTagsOnReleaseImages(fixture);
  });

  it('refuses when the applied-migration count was never proven', () => {
    fixture = createFakeDeployDocker();
    seed(fixture, '2026-10-17T08:50:00Z');

    for (const count of ['unknown', 'not_run', '', 'garbage']) {
      const result = runAttempt(fixture, count === '' ? "''" : count);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('Rollback refused');
    }
    expect(releaseTagWrites(fixture)).toEqual([]);
    expect(composeUps(fixture)).toEqual([]);
  });

  it('a permitted rollback recreates through the immutable rollback tag and leaves release tags alone', () => {
    fixture = createFakeDeployDocker();
    seed(fixture, '2026-10-17T08:50:00Z');
    // The failed recreate left a compose temp container for the dashboard.
    const leftover = `0f0f0f0f0f0f${'9'.repeat(52)}`;
    fixture.addContainer({
      id: leftover,
      name: '7d7f4e41431e_aqua-dashboard',
      state: 'created',
      project: PROJECT,
      service: 'dashboard',
    });

    const result = runAttempt(fixture, '0');

    expect(`${result.stdout}${result.stderr}`).not.toContain('Rollback refused');
    expect(result.status).toBe(0);
    expect(readFileSync(join(fixture.root, 'rollback-images.tsv'), 'utf8')).toBe(
      SERVICES.map((spec) => `${spec.service}\t${spec.preReleaseImage}\n`).join(''),
    );
    for (const spec of SERVICES) {
      expect(fixture.imageOf(`${PREFIX}/${spec.service}:${ROLLBACK_TAG}`)).toBe(
        spec.preReleaseImage,
      );
    }
    expect(releaseTagWrites(fixture)).toEqual([]);
    expectReleaseTagsOnReleaseImages(fixture);
    expect(fixture.removed()).toEqual([leftover]);
    expect(composeUps(fixture)).toEqual([
      `TAG=${ROLLBACK_TAG}\tcompose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate shell dashboard`,
    ]);
  });

  it('does not restore a service whose rollback tag no longer resolves to the captured image', () => {
    fixture = createFakeDeployDocker();
    seed(fixture, '2026-10-17T08:50:00Z');

    const result = runAttempt(
      fixture,
      '0',
      // Something re-pointed the dashboard rollback tag after capture.
      `docker tag sha256:${'7'.repeat(64)} ${PREFIX}/dashboard:${ROLLBACK_TAG}`,
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('dashboard');
    expect(composeUps(fixture)).toEqual([
      `TAG=${ROLLBACK_TAG}\tcompose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate shell`,
    ]);
  });

  it('treats an unreadable release ledger as an unknown schema boundary', () => {
    fixture = createFakeDeployDocker();
    seed(fixture, '2026-10-17T08:50:00Z');
    fixture.setPsqlOutput('ERROR:  relation "platform.release_ledger" does not exist\n');

    const result = runAttempt(fixture, '0');

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(fixture.root, 'rollback-images.tsv'), 'utf8')).toBe('');
    expect(composeUps(fixture)).toEqual([]);
  });

  it('treats a db-migrate run that did not exit cleanly as a schema advance', () => {
    fixture = createFakeDeployDocker();
    seed(fixture, '2026-10-17T08:50:00Z');
    // The ledger knows nothing newer, but db-migrate failed at 08:55 after the
    // containers booted; its outcome on the schema is unproven.
    fixture.setDbMigrateExit('false', '1', '2026-10-17T08:55:00.5Z');

    const result = runAttempt(fixture, '0');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('booted before the latest schema advance');
    expect(composeUps(fixture)).toEqual([]);
  });

  it('writes release tags only from the pinned digest, and the rollback writes none', () => {
    const droplet = readFileSync(join(REPO_ROOT, 'scripts/deploy/droplet-up.sh'), 'utf8');
    const rollback = readFileSync(
      join(REPO_ROOT, 'scripts/deploy/lib/release-rollback.sh'),
      'utf8',
    );
    const tagWrites = [...droplet.split('\n'), ...rollback.split('\n')]
      .map((line) => line.trim())
      .filter((line) => /^(if )?(! )?docker tag /.test(line));

    expect(tagWrites).toEqual([
      'if ! docker tag "${immutable_ref}" "${compose_ref}" || \\',
      '! docker tag "${immutable_ref}" "${deploy_tag_ref}"; then',
      'if ! docker tag "${image_id}" "${rollback_ref}"; then',
    ]);
    expect(droplet).not.toMatch(/^\s*(rollback_deployed_services|capture_rollback_manifest)\(\)/m);
    const restore = /rollback_deployed_services\(\) \{[\s\S]*?\n\}/.exec(rollback)?.[0] ?? '';
    expect(restore).not.toEqual('');
    expect(restore).not.toContain('docker tag');
    expect(restore).toContain('compose_recreate_services "$(rollback_image_tag)"');
  });
});
