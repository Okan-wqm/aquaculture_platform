import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createDbMigrateJestExecutionPlanV1,
  DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1,
  executeDbMigrateJestPlanV1,
  parseDbMigrateJestInvocationV1,
  relayDbMigrateJestOutcomeV1,
  type DbMigrateJestExecutionPlanV1,
  type DbMigrateJestPhaseDescriptorV1,
} from '../../jest-launcher';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');

function readJsonObject(path: string): object {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected one JSON object at ${path}`);
  }
  return parsed;
}

function requireObjectProperty(owner: object, property: string): object {
  const value: unknown = Reflect.get(owner, property);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object property ${property}`);
  }
  return value;
}

function requireStringProperty(owner: object, property: string): string {
  const value: unknown = Reflect.get(owner, property);
  if (typeof value !== 'string') throw new Error(`Expected string property ${property}`);
  return value;
}

function phaseAt(
  plan: DbMigrateJestExecutionPlanV1,
  index: number,
): DbMigrateJestPhaseDescriptorV1 {
  const phase = plan.phases[index];
  if (phase === undefined) throw new Error(`Expected phase ${String(index)} in ${plan.profile}`);
  return phase;
}

function probeCanonicalDdlAuthority(environment: Readonly<NodeJS.ProcessEnv>): string {
  const authorityProbe = [
    "const { hasDbMigrateDdlAuthority } = require('./libs/backend-common/src/database/db-migrate-authority.util.ts');",
    "process.stdout.write(hasDbMigrateDdlAuthority(process.env) ? 'AUTHORIZED' : 'DENIED');",
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    ['--require', 'ts-node/register', '-e', authorityProbe],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        ...environment,
        TS_NODE_PROJECT: join(REPOSITORY_ROOT, 'tools', 'gates', 'tsconfig.json'),
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`DDL authority probe failed: ${result.stderr}`);
  return result.stdout;
}

describe('DbMigrateJestLauncherContractV1', () => {
  it('compiles profiles into immutable least-privilege phase plans', () => {
    const bootstrap = createDbMigrateJestExecutionPlanV1('bootstrap', {});
    const full = createDbMigrateJestExecutionPlanV1('full', {});

    expect(bootstrap.phases).toHaveLength(1);
    expect(phaseAt(bootstrap, 0).id).toBe('PRIVILEGED_BOOTSTRAP');
    expect(phaseAt(bootstrap, 0).privilege).toBe('DDL_PRIVILEGED');
    expect(phaseAt(bootstrap, 0).arguments.slice(1)).toEqual([
      ...DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1.commonJestArguments,
      '--runTestsByPath',
      'apps/db-migrate/src/__tests__/bootstrap-from-scratch.spec.ts',
    ]);

    expect(full.phases).toHaveLength(2);
    expect(full.phases.map((phase) => phase.id)).toEqual([
      'UNPRIVILEGED_SUITE',
      'PRIVILEGED_BOOTSTRAP',
    ]);
    expect(phaseAt(full, 0).arguments.slice(1)).toEqual([
      ...DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1.commonJestArguments,
      '--testPathIgnorePatterns',
      '/bootstrap-from-scratch\\.spec\\.ts$',
    ]);
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.isFrozen(full.phases)).toBe(true);
    expect(full.phases.every((phase) => Object.isFrozen(phase))).toBe(true);
  });

  it('removes inherited authority and execution injection before assigning phase privilege', () => {
    const inherited: NodeJS.ProcessEnv = {
      AQUA_ENV: 'production',
      DB_MIGRATE_AUTHORITATIVE: 'true',
      DB_MIGRATE_DDL_AUTHORITY: '1',
      KEEP_ME: 'retained',
      NODE_ENV: 'production',
      NODE_OPTIONS: '--require=/tmp/injected.cjs',
      NODE_PATH: '/tmp/injected-modules',
      TS_NODE_PROJECT: '/tmp/injected-tsconfig.json',
      TS_NODE_TRANSPILE_ONLY: 'true',
    };
    const plan = createDbMigrateJestExecutionPlanV1('full', inherited);
    const unprivileged = phaseAt(plan, 0).environment;
    const privileged = phaseAt(plan, 1).environment;

    for (const environment of [unprivileged, privileged]) {
      expect(environment['NODE_ENV']).toBe('test');
      expect(environment['AQUA_ENV']).toBe('test');
      expect(environment['DB_MIGRATE_AUTHORITATIVE']).toBe('false');
      expect(environment['KEEP_ME']).toBe('retained');
      expect(environment['NODE_OPTIONS']).toBeUndefined();
      expect(environment['NODE_PATH']).toBeUndefined();
      expect(Object.keys(environment).some((key) => key.startsWith('TS_NODE_'))).toBe(false);
    }
    expect(unprivileged['DB_MIGRATE_DDL_AUTHORITY']).toBeUndefined();
    expect(privileged['DB_MIGRATE_DDL_AUTHORITY']).toBe('1');
    expect(inherited['NODE_OPTIONS']).toBe('--require=/tmp/injected.cjs');
  });

  it('establishes DDL authority only at privileged child-process birth', () => {
    const plan = createDbMigrateJestExecutionPlanV1('full', {});
    expect(probeCanonicalDdlAuthority(phaseAt(plan, 0).environment)).toBe('DENIED');
    expect(probeCanonicalDdlAuthority(phaseAt(plan, 1).environment)).toBe('AUTHORIZED');
  });

  it('rejects missing, unknown, and extra CLI arguments', () => {
    expect(parseDbMigrateJestInvocationV1(['bootstrap'])).toBe('bootstrap');
    expect(parseDbMigrateJestInvocationV1(['full'])).toBe('full');
    for (const invocation of [
      [],
      ['unknown'],
      ['full', '--runTestsByPath'],
      ['bootstrap', 'extra'],
    ]) {
      expect(() => parseDbMigrateJestInvocationV1(invocation)).toThrow(
        /requires exactly one argument/,
      );
    }
  });

  it('runs phases in order and fails fast on the first non-zero status', () => {
    const plan = createDbMigrateJestExecutionPlanV1('full', {});
    const observed: string[] = [];
    const outcome = executeDbMigrateJestPlanV1(plan, (phase) => {
      observed.push(phase.id);
      return Object.freeze({ kind: 'EXITED', status: 17 });
    });

    expect(outcome).toEqual({
      kind: 'EXITED',
      phaseId: 'UNPRIVILEGED_SUITE',
      status: 17,
    });
    expect(observed).toEqual(['UNPRIVILEGED_SUITE']);

    const exits: number[] = [];
    relayDbMigrateJestOutcomeV1(outcome, {
      exit: (status) => exits.push(status),
      signal: () => undefined,
    });
    expect(exits).toEqual([17]);
  });

  it('completes only after both full-profile phases exit zero', () => {
    const plan = createDbMigrateJestExecutionPlanV1('full', {});
    const observed: string[] = [];
    const outcome = executeDbMigrateJestPlanV1(plan, (phase) => {
      observed.push(phase.id);
      return Object.freeze({ kind: 'EXITED', status: 0 });
    });

    expect(outcome).toEqual({ kind: 'COMPLETED' });
    expect(observed).toEqual(['UNPRIVILEGED_SUITE', 'PRIVILEGED_BOOTSTRAP']);
  });

  it('preserves signal cancellation through an injectable termination relay', () => {
    const plan = createDbMigrateJestExecutionPlanV1('bootstrap', {});
    const outcome = executeDbMigrateJestPlanV1(plan, () =>
      Object.freeze({ kind: 'SIGNALED', signal: 'SIGTERM' }),
    );
    const exits: number[] = [];
    const signals: NodeJS.Signals[] = [];

    relayDbMigrateJestOutcomeV1(outcome, {
      exit: (status) => exits.push(status),
      signal: (signal) => signals.push(signal),
    });
    expect(exits).toEqual([]);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('keeps spawn failures typed and outside exit-status projection', () => {
    const failure = new Error('spawn sentinel');
    const outcome = executeDbMigrateJestPlanV1(
      createDbMigrateJestExecutionPlanV1('bootstrap', {}),
      () => Object.freeze({ error: failure, kind: 'SPAWN_FAILED' }),
    );
    expect(outcome).toEqual({
      error: failure,
      kind: 'SPAWN_FAILED',
      phaseId: 'PRIVILEGED_BOOTSTRAP',
    });
    expect(() =>
      relayDbMigrateJestOutcomeV1(outcome, {
        exit: () => undefined,
        signal: () => undefined,
      }),
    ).toThrow(failure);
  });

  it('keeps package and Nx commands as checked projections of the profile SSOT', () => {
    const packageJson = readJsonObject(join(REPOSITORY_ROOT, 'package.json'));
    const scripts = requireObjectProperty(packageJson, 'scripts');
    expect(requireStringProperty(scripts, 'test:db-migrate')).toBe(
      DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1.profiles.full.packageScript,
    );
    expect(requireStringProperty(scripts, 'test:bootstrap')).toBe(
      DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1.profiles.bootstrap.packageScript,
    );

    const project = readJsonObject(join(REPOSITORY_ROOT, 'apps', 'db-migrate', 'project.json'));
    const targets = requireObjectProperty(project, 'targets');
    const testTarget = requireObjectProperty(targets, 'test');
    const options = requireObjectProperty(testTarget, 'options');
    expect(requireStringProperty(options, 'command')).toBe('npm run test:db-migrate');
  });
});
