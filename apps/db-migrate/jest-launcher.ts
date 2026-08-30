import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const launcherRequire = createRequire(__filename);
const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const LAUNCHER_COMMAND =
  'ts-node --project tools/gates/tsconfig.json apps/db-migrate/jest-launcher.ts';

export type DbMigrateJestProfileV1 = 'bootstrap' | 'full';
export type DbMigrateJestPhaseIdV1 = 'PRIVILEGED_BOOTSTRAP' | 'UNPRIVILEGED_SUITE';
export type DbMigrateJestPhasePrivilegeV1 = 'DDL_PRIVILEGED' | 'UNPRIVILEGED';

const BOOTSTRAP_PROFILE_PHASES: readonly DbMigrateJestPhaseIdV1[] = Object.freeze([
  'PRIVILEGED_BOOTSTRAP',
]);
const FULL_PROFILE_PHASES: readonly DbMigrateJestPhaseIdV1[] = Object.freeze([
  'UNPRIVILEGED_SUITE',
  'PRIVILEGED_BOOTSTRAP',
]);

interface DbMigrateJestPhaseContractV1 {
  readonly id: DbMigrateJestPhaseIdV1;
  readonly jestArguments: readonly string[];
  readonly privilege: DbMigrateJestPhasePrivilegeV1;
}

interface DbMigrateJestProfileContractV1 {
  readonly packageScript: string;
  readonly phases: readonly DbMigrateJestPhaseIdV1[];
}

interface DbMigrateJestLauncherContractV1 {
  readonly authorityEnvironment: Readonly<{
    readonly key: 'DB_MIGRATE_DDL_AUTHORITY';
    readonly value: '1';
  }>;
  readonly commonJestArguments: readonly string[];
  readonly deniedInheritedEnvironmentKeys: readonly string[];
  readonly deniedInheritedEnvironmentPrefixes: readonly string[];
  readonly normalizedEnvironment: Readonly<{
    readonly AQUA_ENV: 'test';
    readonly DB_MIGRATE_AUTHORITATIVE: 'false';
    readonly NODE_ENV: 'test';
  }>;
  readonly phases: Readonly<Record<DbMigrateJestPhaseIdV1, DbMigrateJestPhaseContractV1>>;
  readonly profiles: Readonly<Record<DbMigrateJestProfileV1, DbMigrateJestProfileContractV1>>;
  readonly schemaVersion: 'DbMigrateJestLauncherContractV1';
}

export const DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1: DbMigrateJestLauncherContractV1 = Object.freeze({
  authorityEnvironment: Object.freeze({
    key: 'DB_MIGRATE_DDL_AUTHORITY',
    value: '1',
  }),
  commonJestArguments: Object.freeze([
    '--config',
    'apps/db-migrate/jest.config.cts',
    '--runInBand',
  ]),
  deniedInheritedEnvironmentKeys: Object.freeze(['NODE_OPTIONS', 'NODE_PATH']),
  deniedInheritedEnvironmentPrefixes: Object.freeze(['TS_NODE_']),
  normalizedEnvironment: Object.freeze({
    AQUA_ENV: 'test',
    DB_MIGRATE_AUTHORITATIVE: 'false',
    NODE_ENV: 'test',
  }),
  phases: Object.freeze({
    PRIVILEGED_BOOTSTRAP: Object.freeze({
      id: 'PRIVILEGED_BOOTSTRAP',
      jestArguments: Object.freeze([
        '--runTestsByPath',
        'apps/db-migrate/src/__tests__/bootstrap-from-scratch.spec.ts',
      ]),
      privilege: 'DDL_PRIVILEGED',
    }),
    UNPRIVILEGED_SUITE: Object.freeze({
      id: 'UNPRIVILEGED_SUITE',
      jestArguments: Object.freeze([
        '--testPathIgnorePatterns',
        '/bootstrap-from-scratch\\.spec\\.ts$',
      ]),
      privilege: 'UNPRIVILEGED',
    }),
  }),
  profiles: Object.freeze({
    bootstrap: Object.freeze({
      packageScript: `${LAUNCHER_COMMAND} bootstrap`,
      phases: BOOTSTRAP_PROFILE_PHASES,
    }),
    full: Object.freeze({
      packageScript: `${LAUNCHER_COMMAND} full`,
      phases: FULL_PROFILE_PHASES,
    }),
  }),
  schemaVersion: 'DbMigrateJestLauncherContractV1',
});

export interface DbMigrateJestPhaseDescriptorV1 {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
  readonly id: DbMigrateJestPhaseIdV1;
  readonly privilege: DbMigrateJestPhasePrivilegeV1;
  readonly repositoryRoot: string;
  readonly schemaVersion: 'DbMigrateJestPhaseDescriptorV1';
}

export interface DbMigrateJestExecutionPlanV1 {
  readonly phases: readonly DbMigrateJestPhaseDescriptorV1[];
  readonly profile: DbMigrateJestProfileV1;
  readonly schemaVersion: 'DbMigrateJestExecutionPlanV1';
}

export type DbMigrateJestPhaseResultV1 =
  | Readonly<{ readonly kind: 'EXITED'; readonly status: number }>
  | Readonly<{ readonly kind: 'SIGNALED'; readonly signal: NodeJS.Signals }>
  | Readonly<{ readonly error: Error; readonly kind: 'SPAWN_FAILED' }>;

export type DbMigrateJestExecutionOutcomeV1 =
  | Readonly<{ readonly kind: 'COMPLETED' }>
  | Readonly<{
      readonly kind: 'EXITED';
      readonly phaseId: DbMigrateJestPhaseIdV1;
      readonly status: number;
    }>
  | Readonly<{
      readonly kind: 'SIGNALED';
      readonly phaseId: DbMigrateJestPhaseIdV1;
      readonly signal: NodeJS.Signals;
    }>
  | Readonly<{
      readonly error: Error;
      readonly kind: 'SPAWN_FAILED';
      readonly phaseId: DbMigrateJestPhaseIdV1;
    }>;

export type DbMigrateJestPhaseSpawnerV1 = (
  phase: DbMigrateJestPhaseDescriptorV1,
) => DbMigrateJestPhaseResultV1;

export interface DbMigrateJestTerminationRelayV1 {
  readonly exit: (status: number) => void;
  readonly signal: (signal: NodeJS.Signals) => void;
}

export function parseDbMigrateJestInvocationV1(
  arguments_: readonly string[],
): DbMigrateJestProfileV1 {
  if (arguments_.length === 1 && (arguments_[0] === 'bootstrap' || arguments_[0] === 'full')) {
    return arguments_[0];
  }
  throw new Error(
    `${DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1.schemaVersion} requires exactly one ` +
      `argument: bootstrap | full`,
  );
}

function createPhaseEnvironmentV1(
  privilege: DbMigrateJestPhasePrivilegeV1,
  inheritedEnvironment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const contract = DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (
      key === contract.authorityEnvironment.key ||
      contract.deniedInheritedEnvironmentKeys.includes(key) ||
      contract.deniedInheritedEnvironmentPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    if (value !== undefined) environment[key] = value;
  }
  environment['NODE_ENV'] = contract.normalizedEnvironment.NODE_ENV;
  environment['AQUA_ENV'] = contract.normalizedEnvironment.AQUA_ENV;
  environment['DB_MIGRATE_AUTHORITATIVE'] = contract.normalizedEnvironment.DB_MIGRATE_AUTHORITATIVE;
  if (privilege === 'DDL_PRIVILEGED') {
    environment[contract.authorityEnvironment.key] = contract.authorityEnvironment.value;
  }
  return Object.freeze(environment);
}

export function createDbMigrateJestExecutionPlanV1(
  profile: DbMigrateJestProfileV1,
  inheritedEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): DbMigrateJestExecutionPlanV1 {
  const contract = DB_MIGRATE_JEST_LAUNCHER_CONTRACT_V1;
  const jestCli = launcherRequire.resolve('jest/bin/jest');
  const phases = contract.profiles[profile].phases.map((phaseId) => {
    const phase = contract.phases[phaseId];
    return Object.freeze({
      arguments: Object.freeze([jestCli, ...contract.commonJestArguments, ...phase.jestArguments]),
      environment: createPhaseEnvironmentV1(phase.privilege, inheritedEnvironment),
      executable: process.execPath,
      id: phase.id,
      privilege: phase.privilege,
      repositoryRoot: REPOSITORY_ROOT,
      schemaVersion: 'DbMigrateJestPhaseDescriptorV1',
    });
  });
  return Object.freeze({
    phases: Object.freeze(phases),
    profile,
    schemaVersion: 'DbMigrateJestExecutionPlanV1',
  });
}

export function spawnDbMigrateJestPhaseV1(
  phase: DbMigrateJestPhaseDescriptorV1,
): DbMigrateJestPhaseResultV1 {
  const result = spawnSync(phase.executable, [...phase.arguments], {
    cwd: phase.repositoryRoot,
    env: { ...phase.environment },
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    return Object.freeze({ error: result.error, kind: 'SPAWN_FAILED' });
  }
  if (result.signal !== null && result.status === null) {
    return Object.freeze({ kind: 'SIGNALED', signal: result.signal });
  }
  if (result.status !== null && result.signal === null) {
    return Object.freeze({ kind: 'EXITED', status: result.status });
  }
  return Object.freeze({
    error: new Error(`Child returned an invalid status/signal combination for ${phase.id}`),
    kind: 'SPAWN_FAILED',
  });
}

export function executeDbMigrateJestPlanV1(
  plan: DbMigrateJestExecutionPlanV1,
  spawnPhase: DbMigrateJestPhaseSpawnerV1 = spawnDbMigrateJestPhaseV1,
): DbMigrateJestExecutionOutcomeV1 {
  for (const phase of plan.phases) {
    const result = spawnPhase(phase);
    if (result.kind === 'SPAWN_FAILED') {
      return Object.freeze({ error: result.error, kind: result.kind, phaseId: phase.id });
    }
    if (result.kind === 'SIGNALED') {
      return Object.freeze({ kind: result.kind, phaseId: phase.id, signal: result.signal });
    }
    if (result.status !== 0) {
      return Object.freeze({ kind: result.kind, phaseId: phase.id, status: result.status });
    }
  }
  return Object.freeze({ kind: 'COMPLETED' });
}

export function relayDbMigrateJestOutcomeV1(
  outcome: DbMigrateJestExecutionOutcomeV1,
  relay: DbMigrateJestTerminationRelayV1,
): void {
  if (outcome.kind === 'SPAWN_FAILED') throw outcome.error;
  if (outcome.kind === 'SIGNALED') {
    relay.signal(outcome.signal);
    return;
  }
  relay.exit(outcome.kind === 'COMPLETED' ? 0 : outcome.status);
}

const PROCESS_TERMINATION_RELAY_V1: DbMigrateJestTerminationRelayV1 = Object.freeze({
  exit: (status: number): void => {
    process.exitCode = status;
  },
  signal: (signal: NodeJS.Signals): void => {
    process.kill(process.pid, signal);
  },
});

if (require.main === module) {
  try {
    const profile = parseDbMigrateJestInvocationV1(process.argv.slice(2));
    const outcome = executeDbMigrateJestPlanV1(createDbMigrateJestExecutionPlanV1(profile));
    relayDbMigrateJestOutcomeV1(outcome, PROCESS_TERMINATION_RELAY_V1);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}
