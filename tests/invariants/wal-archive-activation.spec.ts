/**
 * Platform invariant — production WAL archiving runs exactly when
 * `.github/manifests/dr-activation.json` declares `production-wal-archive`
 * active, and every runtime projection of that declaration agrees with it.
 *
 * # Why this exists (INFRA-CRITICAL-195)
 *
 * The manifest declared WAL archiving `not-activated` while
 * `docker-compose.droplet.yml` hardcoded `archive_mode=on`. No bucket had been
 * provisioned, so every `wal-push` failed with NoSuchBucket, PostgreSQL kept
 * every segment, and pg_wal reached 65 GB and filled the production disk on
 * 2026-10-02. The healthcheck could only pass when archiving succeeded, so
 * aqua-postgres sat unhealthy for eleven days and blocked every development
 * deploy; the freshness lane read "the image carries the healthcheck" as
 * activation, so it could not have told the two states apart either.
 *
 * Three projections carry the declaration into the runtime:
 *
 *   1. the postgres `command:`  — `-c archive_mode=on|off`
 *   2. the postgres environment — `WALG_ARCHIVE_ACTIVATION`, which selects the
 *      healthcheck's contract (RPO freshness, or "archiving is off")
 *   3. the freshness lane       — observes `archive_mode` on the live server
 *
 * # What a failure means
 *
 * A projection disagrees with the manifest. Activation (plan phase BR-3) is the
 * manifest flip; this test then names the compose lines that must follow, so
 * a partial activation cannot merge.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import {
  REPO_ROOT,
  DR_ACTIVATION_MANIFEST_PATH,
  WAL_ARCHIVE_CAPABILITY,
  archiveModeFor,
  declaredWalArchiveActivation,
  type ArchiveMode,
  type WalArchiveActivation,
} from './lib/wal-archive-activation';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
const HEALTHCHECK_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/postgres-walg-healthcheck.sh',
);
const FRESHNESS_WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github/workflows/database-wal-archive-freshness.yml',
);
const RESOLVER_PATH = join(REPO_ROOT, 'tools/scripts/database/resolve-dr-activation.sh');
const SECRET_LOADER_CALL = '/usr/local/bin/walg-load-secrets.sh assert-runtime';
const STATES: readonly WalArchiveActivation[] = ['active', 'not-activated'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function postgresService(): Record<string, unknown> {
  const compose: unknown = yaml.load(readFileSync(COMPOSE_PATH, 'utf8'));
  const services = isRecord(compose) ? compose.services : undefined;
  const postgres = isRecord(services) ? services.postgres : undefined;
  if (!isRecord(postgres)) throw new Error('docker-compose.droplet.yml must define postgres');
  return postgres;
}

function postgresCommand(): string {
  const command = postgresService().command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((item) => typeof item === 'string')) {
    return command.join(' ');
  }
  throw new Error('services.postgres.command must be a string or string array');
}

/** Every `-c archive_mode=<value>` the postgres command passes, in order. */
function composeArchiveModes(): string[] {
  return [...postgresCommand().matchAll(/(?:^|\s)-c\s+"?archive_mode=([^\s"]+)/g)].map(
    (match) => match[1] ?? '',
  );
}

function postgresEnvironment(): Record<string, string> {
  const environment = postgresService().environment;
  if (!isRecord(environment)) throw new Error('services.postgres.environment must be a mapping');
  return Object.fromEntries(Object.entries(environment).map(([k, v]) => [k, String(v)]));
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Opposite declared state, for proving each contract rejects the other. */
function otherState(state: WalArchiveActivation): WalArchiveActivation {
  return state === 'active' ? 'not-activated' : 'active';
}

interface HealthcheckRun {
  readonly activation: string | undefined;
  readonly archiveMode: ArchiveMode;
  readonly ready?: boolean;
}

/**
 * Runs the real healthcheck against fake PostgreSQL client binaries. The fake
 * psql answers `SHOW`-style queries with the given archive_mode and evaluates
 * the active contract's archiver query the way PostgreSQL would for that mode.
 * The WAL-G secret loader is replaced by `true` only for the active contract:
 * the not-activated contract must never need WAL-G credentials.
 */
function runHealthcheck(run: HealthcheckRun): SpawnSyncReturns<string> {
  const script = readFileSync(HEALTHCHECK_PATH, 'utf8');
  expect(script).toContain(SECRET_LOADER_CALL);
  const harness = script.replace(SECRET_LOADER_CALL, '"${FAKE_SECRET_LOADER:?}"');
  const scratch = mkdtempSync(join(tmpdir(), 'aqua-wal-activation-health-'));
  try {
    const fakeBin = join(scratch, 'bin');
    const pgdata = join(scratch, 'pgdata');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(pgdata, 'pg_wal', 'archive_status'), { recursive: true });
    writeExecutable(
      join(fakeBin, 'pg_isready'),
      '#!/usr/bin/env bash\nexit "${FAKE_PG_READY:?}"\n',
    );
    writeExecutable(
      join(fakeBin, 'psql'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        "  *pg_stat_archiver*) [ \"${FAKE_ARCHIVE_MODE}\" = on ] && printf 't\\n' || printf 'f\\n' ;;",
        '  *archive_mode*) printf \'%s\\n\' "${FAKE_ARCHIVE_MODE}" ;;',
        '  *) exit 3 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    writeExecutable(
      join(fakeBin, 'df'),
      "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'test 100 10 90 10%% /test\\n'\n",
    );
    const environment: Record<string, string> = {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      PGDATA: pgdata,
      FAKE_ARCHIVE_MODE: run.archiveMode,
      FAKE_PG_READY: run.ready === false ? '2' : '0',
      FAKE_SECRET_LOADER: run.activation === 'active' ? 'true' : 'false',
      WALG_BACKUP_EPOCH: 'test-epoch',
      WALG_S3_PREFIX: 's3://test/postgres/wal-g/test-epoch',
      WALG_S3_ENDPOINT: 'https://object.invalid',
      WALG_S3_REGION: 'test-1',
      WALG_RPO_BUDGET_SECONDS: '300',
      WALG_ARCHIVE_SWITCH_BUDGET_SECONDS: '225',
      WALG_WAL_PUSH_BUDGET_SECONDS: '45',
      WALG_HEALTH_DETECTION_BUDGET_SECONDS: '30',
    };
    if (run.activation !== undefined) environment.WALG_ARCHIVE_ACTIVATION = run.activation;
    return spawnSync('bash', ['-s'], {
      cwd: scratch,
      encoding: 'utf8',
      env: environment,
      input: harness,
    });
  } finally {
    removeFixtureTree(scratch);
  }
}

/** The remote payload of the lane's observe step, exactly as the runner ships it. */
function freshnessProbePayload(): string {
  const workflow: unknown = yaml.load(readFileSync(FRESHNESS_WORKFLOW_PATH, 'utf8'));
  const jobs = isRecord(workflow) ? workflow.jobs : undefined;
  const verify = isRecord(jobs) ? jobs.verify : undefined;
  const steps = isRecord(verify) && Array.isArray(verify.steps) ? verify.steps : [];
  const observe = steps.find((step: unknown) => isRecord(step) && step.id === 'observe');
  const run = isRecord(observe) ? observe.run : undefined;
  if (typeof run !== 'string') throw new Error('freshness lane must have an observe step');
  const opening = "<<'AQUA_REMOTE_SCRIPT'\n";
  const start = run.indexOf(opening);
  const end = run.indexOf('\nAQUA_REMOTE_SCRIPT\n', start);
  if (start < 0 || end < 0) throw new Error('observe step must ship an AQUA_REMOTE_SCRIPT payload');
  return run.slice(start + opening.length, end + 1);
}

interface HostState {
  readonly running: boolean;
  readonly archiveMode: ArchiveMode | 'unreadable';
  readonly healthcheckStatus?: number;
}

interface LaneOutcome {
  readonly observed: string;
  readonly rpo: string;
  readonly resolverStatus: number | null;
  readonly verdict: string;
}

/**
 * Runs the lane's real probe payload against a fake `docker` that models the
 * production host (the WAL-G image is always present there), then feeds the
 * observation to the real resolver with the given declared state.
 */
function runLane(declared: WalArchiveActivation, host: HostState): LaneOutcome {
  const scratch = mkdtempSync(join(tmpdir(), 'aqua-wal-activation-lane-'));
  try {
    const fakeBin = join(scratch, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, 'docker'),
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  inspect) printf \'%s\\n\' "${FAKE_RUNNING:?}" ;;',
        '  exec)',
        '    shift 2',
        '    case "$*" in',
        '      *archive_mode*)',
        '        [ "${FAKE_ARCHIVE_MODE:?}" != unreadable ] || exit 2',
        '        printf \'%s\\n\' "${FAKE_ARCHIVE_MODE}" ;;',
        '      test\\ -x\\ *) exit 0 ;;',
        '      */usr/local/bin/postgres-walg-healthcheck.sh*) exit "${FAKE_HEALTH_STATUS:?}" ;;',
        '      *) exit 64 ;;',
        '    esac ;;',
        '  *) exit 64 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    const probe = spawnSync('bash', ['--noprofile', '--norc', '-s'], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        FAKE_RUNNING: host.running ? 'true' : 'false',
        FAKE_ARCHIVE_MODE: host.archiveMode,
        FAKE_HEALTH_STATUS: String(host.healthcheckStatus ?? 0),
      },
      input: freshnessProbePayload(),
    });
    expect(probe.status).toBe(0);
    const field = (name: string): string =>
      new RegExp(`^${name}=(.*)$`, 'm').exec(probe.stdout)?.[1] ?? '';

    const manifestPath = join(scratch, 'dr-activation.json');
    const manifest: unknown = JSON.parse(readFileSync(DR_ACTIVATION_MANIFEST_PATH, 'utf8'));
    const capabilities = isRecord(manifest) ? manifest.capabilities : undefined;
    const capability = isRecord(capabilities) ? capabilities[WAL_ARCHIVE_CAPABILITY] : undefined;
    if (!isRecord(capability)) throw new Error(`manifest must declare ${WAL_ARCHIVE_CAPABILITY}`);
    capability.state = declared;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const resolver = spawnSync('bash', [RESOLVER_PATH], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        DR_CAPABILITY: WAL_ARCHIVE_CAPABILITY,
        DR_OBSERVED: field('dr_observed'),
        DR_MANIFEST_PATH: manifestPath,
      },
    });
    return {
      observed: field('dr_observed'),
      rpo: field('rpo'),
      resolverStatus: resolver.status,
      verdict: /^dr_verdict=(.*)$/m.exec(resolver.stdout)?.[1] ?? '',
    };
  } finally {
    removeFixtureTree(scratch);
  }
}

describe('production WAL archiving follows its one declared activation state', () => {
  const declared = declaredWalArchiveActivation();

  it('starts PostgreSQL with exactly the archive_mode the manifest declares', () => {
    expect({ declared, archiveModes: composeArchiveModes() }).toEqual({
      declared,
      archiveModes: [archiveModeFor(declared)],
    });
  });

  it('hands the healthcheck the declared state as a literal, never an override', () => {
    expect(postgresEnvironment().WALG_ARCHIVE_ACTIVATION).toBe(declared);
  });

  it('is healthy in the server compose actually starts', () => {
    const [composeMode] = composeArchiveModes();
    if (composeMode !== 'on' && composeMode !== 'off') {
      throw new Error(
        `compose must start postgres with archive_mode on or off, got ${composeMode}`,
      );
    }
    const result = runHealthcheck({
      activation: postgresEnvironment().WALG_ARCHIVE_ACTIVATION,
      archiveMode: composeMode,
    });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it.each(STATES)('judges %s by its own contract and rejects the other mode', (state) => {
    const matching = runHealthcheck({ activation: state, archiveMode: archiveModeFor(state) });
    const opposite = runHealthcheck({
      activation: state,
      archiveMode: archiveModeFor(otherState(state)),
    });

    expect(matching.status).toBe(0);
    expect(opposite.status).toBe(1);
    expect(opposite.stderr).toContain('WAL-G healthcheck failed');
  });

  it('fails closed on a missing or unknown activation value', () => {
    for (const activation of [undefined, '', 'on', 'Active']) {
      const result = runHealthcheck({ activation, archiveMode: 'off' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('WALG_ARCHIVE_ACTIVATION');
    }
  });

  it('still requires a ready server when archiving is not activated', () => {
    const result = runHealthcheck({
      activation: 'not-activated',
      archiveMode: 'off',
      ready: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PostgreSQL is not ready');
  });

  it.each([
    ['not-activated', { running: true, archiveMode: 'off' }, 'absent', 0, 'inactive-as-declared'],
    ['not-activated', { running: true, archiveMode: 'on' }, 'present', 1, ''],
    ['active', { running: true, archiveMode: 'on' }, 'present', 0, 'active'],
    ['active', { running: true, archiveMode: 'off' }, 'absent', 1, ''],
    ['active', { running: false, archiveMode: 'on' }, 'indeterminate', 1, ''],
    ['not-activated', { running: true, archiveMode: 'unreadable' }, 'indeterminate', 1, ''],
  ] as const)(
    'freshness lane: declared %s, host %j observes %s and resolves with exit %i',
    (state, host, observed, resolverStatus, verdict) => {
      const outcome = runLane(state, host);

      expect(outcome).toMatchObject({ observed, resolverStatus, verdict });
    },
  );

  it('freshness lane enforces the RPO only on an archiving runtime', () => {
    expect(runLane('active', { running: true, archiveMode: 'on', healthcheckStatus: 0 }).rpo).toBe(
      'healthy',
    );
    expect(runLane('active', { running: true, archiveMode: 'on', healthcheckStatus: 1 }).rpo).toBe(
      'breached',
    );
  });
});
