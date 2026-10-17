/**
 * INFRA-HIGH-230 — compose service recreation survives a failed attempt and
 * refuses a name it does not own, before it stops anything.
 *
 * CI - Affected run 38990686731 (deploy-development/deploy), 2026-10-17:
 *   attempt 3  `service:aquamobil:1 ... Conflict. The container name
 *              "/aqua-mobile" is already in use by container "740006e18d09..."`
 *              — a container compose did not own held the target name; compose
 *              aborted mid-recreate and left `<id12>_aqua-*` temp containers.
 *   attempt 4  `Container 7d7f4e41431e_aqua-dashboard ... Error when allocating
 *              new name: Conflict. The container name "/aqua-dashboard" is
 *              already in use by container "7d7f4e41431e..."` — compose took the
 *              temp container as the one to replace, removed it, and could not
 *              rename its new container onto the name the original still held.
 *
 * `compose_recreate_services` (scripts/deploy/lib/compose-recreate.sh) runs
 * `scripts/deploy/compose-container-preflight.ts` first. These specs drive both
 * against a fake Docker daemon and assert the Docker side effects.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createFakeDeployDocker, type FakeDockerFixture } from './helpers/fake-deploy-docker';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PROJECT = 'aqua-saas';

function composeConfig(fixture: FakeDockerFixture): void {
  fixture.writeComposeConfig(PROJECT, {
    dashboard: 'aqua-dashboard',
    aquamobil: 'aqua-mobile',
    'auth-service': 'aqua-auth',
  });
}

function runPreflight(
  fixture: FakeDockerFixture,
  services: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/deploy/compose-container-preflight.ts'), ...services],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        FAKE_DOCKER_STATE: fixture.state,
        COMPOSE_FILE: 'docker-compose.droplet.yml',
        TAG: 'ffd6aa2f4b7ac0668a65e3ef41ea2bd845743281',
      },
    },
  );
}

function runComposeRecreate(
  fixture: FakeDockerFixture,
  tag: string,
  services: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source scripts/deploy/lib/compose-recreate.sh; compose_recreate_services "$@"',
      'compose-recreate',
      tag,
      ...services,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        FAKE_DOCKER_STATE: fixture.state,
        TAG: 'should-be-overridden',
      },
    },
  );
}

function composeUps(fixture: FakeDockerFixture): string[] {
  return fixture.invocations().filter((line) => /\tcompose .*\bup\b/.test(line));
}

describe('compose recreate preflight (INFRA-HIGH-230)', () => {
  let fixture: FakeDockerFixture;

  beforeEach(() => {
    fixture = createFakeDeployDocker();
    composeConfig(fixture);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('removes the temp container a failed recreate left before compose replaces the service', () => {
    const original = `7d7f4e41431e${'a'.repeat(52)}`;
    const leftover = `37dd3f97a5ae${'b'.repeat(52)}`;
    fixture.addContainer({
      id: original,
      name: 'aqua-dashboard',
      state: 'running',
      project: PROJECT,
      service: 'dashboard',
    });
    fixture.addContainer({
      id: leftover,
      name: '7d7f4e41431e_aqua-dashboard',
      state: 'created',
      project: PROJECT,
      service: 'dashboard',
    });

    const result = runPreflight(fixture, ['dashboard']);

    expect(result.status).toBe(0);
    expect(fixture.removed()).toEqual([leftover]);
    expect(`${result.stdout}${result.stderr}`).toContain('7d7f4e41431e_aqua-dashboard');
    // The service's own container is compose's to replace, never the preflight's.
    expect(fixture.removed()).not.toContain(original);
  });

  it('removes leftovers before compose up and passes the requested image tag to compose', () => {
    const leftover = `f33602842a24${'c'.repeat(52)}`;
    fixture.addContainer({
      id: `aaaaaaaaaaaa${'d'.repeat(52)}`,
      name: 'aqua-auth',
      state: 'running',
      project: PROJECT,
      service: 'auth-service',
    });
    fixture.addContainer({
      id: leftover,
      name: 'aaaaaaaaaaaa_aqua-auth',
      state: 'created',
      project: PROJECT,
      service: 'auth-service',
    });

    const result = runComposeRecreate(fixture, 'rollback-ffd6aa2f4-20261017T085545Z', [
      'auth-service',
    ]);

    expect(result.status).toBe(0);
    const calls = fixture.invocations();
    const removal = calls.findIndex((line) => line.includes(`\trm -f ${leftover}`));
    const up = calls.findIndex((line) => /\tcompose .*\bup\b/.test(line));
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(removal);
    expect(calls[up]).toMatch(
      /^TAG=rollback-ffd6aa2f4-20261017T085545Z\tcompose -f docker-compose\.droplet\.yml up -d --no-deps --no-build --force-recreate auth-service$/,
    );
  });

  it('fails before any mutation when a container compose does not own holds the name', () => {
    const foreign = `740006e18d09${'e'.repeat(52)}`;
    const leftover = `7d7f4e41431e${'f'.repeat(52)}`;
    fixture.addContainer({
      id: foreign,
      name: 'aqua-mobile',
      state: 'running',
      project: 'codex-sim',
      service: 'mobile',
    });
    fixture.addContainer({
      id: leftover,
      name: '7d7f4e41431e_aqua-dashboard',
      state: 'created',
      project: PROJECT,
      service: 'dashboard',
    });

    const result = runComposeRecreate(fixture, 'ffd6aa2f4b7ac0668a65e3ef41ea2bd845743281', [
      'dashboard',
      'aquamobil',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('aqua-mobile');
    expect(output).toContain('740006e18d09');
    expect(output).toContain('codex-sim');
    // Nothing is removed, stopped or recreated: the conflict is decided first.
    expect(fixture.removed()).toEqual([]);
    expect(composeUps(fixture)).toEqual([]);
    expect(fixture.invocations().some((line) => /\t(stop|kill|rm)\b/.test(line))).toBe(false);
  });

  it('treats an unlabeled container holding the name as foreign', () => {
    fixture.addContainer({
      id: `740006e18d09${'1'.repeat(52)}`,
      name: 'aqua-mobile',
      state: 'exited',
      project: '',
      service: '',
    });

    const result = runPreflight(fixture, ['aquamobil']);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/aqua-mobile.*740006e18d09/);
    expect(fixture.removed()).toEqual([]);
  });

  it('treats a same-project container of another service holding the name as foreign', () => {
    fixture.addContainer({
      id: `0123456789ab${'2'.repeat(52)}`,
      name: 'aqua-dashboard',
      state: 'running',
      project: PROJECT,
      service: 'shell',
    });

    const result = runPreflight(fixture, ['dashboard']);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('aqua-dashboard');
    expect(fixture.removed()).toEqual([]);
  });

  it('leaves temp-named containers of other projects alone', () => {
    fixture.addContainer({
      id: `bbbbbbbbbbbb${'3'.repeat(52)}`,
      name: '7d7f4e41431e_aqua-dashboard',
      state: 'created',
      project: 'codex-sim',
      service: 'dashboard',
    });

    const result = runPreflight(fixture, ['dashboard']);

    expect(result.status).toBe(0);
    expect(fixture.removed()).toEqual([]);
  });

  it('refuses a service the compose configuration does not define', () => {
    const result = runPreflight(fixture, ['not-a-service']);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('not-a-service');
    expect(fixture.removed()).toEqual([]);
  });

  it('is the only path the selective rollout uses to recreate services', () => {
    const droplet = readFileSync(join(REPO_ROOT, 'scripts/deploy/droplet-up.sh'), 'utf8');
    const lib = readFileSync(join(REPO_ROOT, 'scripts/deploy/lib/compose-recreate.sh'), 'utf8');

    expect(droplet).toContain('source scripts/deploy/lib/compose-recreate.sh');
    expect(droplet).toContain(
      'if ! compose_recreate_services "${TAG}" ${RESTART_SERVICES} 2>&1; then',
    );
    expect(droplet).not.toContain('--force-recreate ${RESTART_SERVICES}');
    expect(lib).toContain('node scripts/deploy/compose-container-preflight.ts "$@"');
  });
});
