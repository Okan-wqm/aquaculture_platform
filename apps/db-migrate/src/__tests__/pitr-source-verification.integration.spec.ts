import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  bootPostgresContainer,
  DEFAULT_POSTGRES_IMAGE,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import {
  runPlatformBootstrap,
  resolvePlatformBootstrapSqlDir,
} from '../platform-bootstrap.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SOURCE_VERIFICATION_SQL = readFileSync(
  resolve(REPO_ROOT, 'tools/scripts/database/pitr-source-verification-locks.sql'),
  'utf8',
);
const SQL_DIR = resolvePlatformBootstrapSqlDir(REPO_ROOT);
const MAIN_SHA = 'a'.repeat(40);
const MIGRATION_SCHEMAS = [
  'admin',
  'ai',
  'alert',
  'auth',
  'billing',
  'config',
  'event_store',
  'farm',
  'hr',
  'hydroponics',
  'messaging',
  'notification',
  'observability',
  'sensor',
] as const;
const SERVICE_ROLE_PASS_ENVS = [
  'AUTH_SERVICE_DB_PASS',
  'FARM_SERVICE_DB_PASS',
  'SENSOR_SERVICE_DB_PASS',
  'BILLING_SERVICE_DB_PASS',
  'HR_SERVICE_DB_PASS',
  'ALERT_SERVICE_DB_PASS',
  'ADMIN_SERVICE_DB_PASS',
  'GATEWAY_SERVICE_DB_PASS',
  'NOTIFICATION_SERVICE_DB_PASS',
  'HYDROPONICS_SERVICE_DB_PASS',
  'AI_SERVICE_DB_PASS',
  'MESSAGING_SERVICE_DB_PASS',
  'OBSERVABILITY_SERVICE_DB_PASS',
  'EVENT_STORE_SERVICE_DB_PASS',
  'CONFIG_SERVICE_DB_PASS',
] as const;

function parsePostgresLsn(value: string): bigint {
  const match = /^([0-9A-F]+)\/([0-9A-F]{1,8})$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid PostgreSQL LSN: ${value}`);
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function withServiceRoleEnvs(): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ROLE_PASS_ENVS) {
    saved.set(key, process.env[key]);
    process.env[key] = `test-${key.toLowerCase().replace(/_/g, '-')}-secret`;
  }
  return {
    restore(): void {
      for (const [key, value] of saved.entries()) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

describe('bootstrap-free PITR source verification authority (INFRA-HIGH-051)', () => {
  let ctx: HarnessContext;
  let envHandle: { restore: () => void };

  beforeAll(async () => {
    envHandle = withServiceRoleEnvs();
    ctx = await bootPostgresContainer();
    await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: () => undefined,
      lockTimeoutSeconds: 30,
    });

    const qr = ctx.dataSource.createQueryRunner();
    try {
      await qr.query(`CREATE TABLE auth.tenants (id uuid PRIMARY KEY)`);
      await qr.query(`CREATE TABLE auth.users (id uuid PRIMARY KEY)`);
      await qr.query(`INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111')`);
      await qr.query(`ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY`);
      await qr.query(`ALTER TABLE auth.users FORCE ROW LEVEL SECURITY`);
      await qr.query(`CREATE POLICY pitr_source_deny_all ON auth.users USING (false)`);
      await qr.query(`CREATE TABLE billing.subscriptions (id uuid PRIMARY KEY)`);
      await qr.query(
        `CREATE TABLE admin.tenant_schemas (
           "tenantId" uuid PRIMARY KEY,
           "schemaName" text NOT NULL,
           status text NOT NULL DEFAULT 'active'
         )`,
      );
      for (const schema of MIGRATION_SCHEMAS) {
        await qr.query(
          `CREATE TABLE "${schema}".migrations (
             id bigserial PRIMARY KEY,
             "timestamp" bigint NOT NULL,
             name text NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO "${schema}".migrations ("timestamp", name) VALUES (100, 'Initial')`,
        );
      }
      const expectedSchemas = Object.fromEntries(
        MIGRATION_SCHEMAS.map((schema) => [schema, { timestamp: '100', name: 'Initial' }]),
      );
      await qr.query(
        `INSERT INTO platform.release_ledger
           (release_id, git_sha, expected_heads, tenant_fanout, status)
         VALUES ($1, $2, $3::jsonb, '{}'::jsonb, 'db_complete')`,
        [
          'pitr-source-verification-test',
          MAIN_SHA,
          JSON.stringify({ schemas: expectedSchemas, tenants: {} }),
        ],
      );
    } finally {
      await qr.release();
    }
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
    envHandle?.restore();
  }, 30_000);

  it('contains no persistent mutation or shell escape surface', () => {
    expect(SOURCE_VERIFICATION_SQL).toContain('READ COMMITTED, READ ONLY');
    expect(SOURCE_VERIFICATION_SQL).toContain("current_setting('transaction_read_only') <> 'on'");
    expect(SOURCE_VERIFICATION_SQL).toContain('AND rolsuper');
    expect(SOURCE_VERIFICATION_SQL).toContain('SET LOCAL row_security = off');
    expect(SOURCE_VERIFICATION_SQL).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i,
    );
    expect(SOURCE_VERIFICATION_SQL).not.toContain('\\!');
    expect(SOURCE_VERIFICATION_SQL).not.toContain('SECURITY DEFINER');
    expect(SOURCE_VERIFICATION_SQL).not.toContain('aqua_pitr_verifier');
    expect(SOURCE_VERIFICATION_SQL).toContain('pg_catalog.pg_current_wal_insert_lsn()');
    expect(SOURCE_VERIFICATION_SQL).not.toContain('pg_catalog.pg_current_wal_lsn()');
  });

  it('emits exactly the four fail-closed psql protocol records', async () => {
    const result = await ctx.container.exec([
      '/usr/bin/env',
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'HOME=/nonexistent',
      'LC_ALL=C',
      'PGHOST=/var/run/postgresql',
      `PGUSER=${ctx.connectionOptions.username}`,
      `PGDATABASE=${ctx.connectionOptions.database}`,
      '/usr/bin/psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;\n${SOURCE_VERIFICATION_SQL}\nROLLBACK;`,
    ]);
    expect(result.exitCode).toBe(0);
    const lines = result.output.trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('ROOTS_LOCKED');
    expect(lines[1]).toMatch(/^[0-9a-f]{64}\|19\|5000\|120000\|30000$/);
    expect(lines[2]?.split('|')).toHaveLength(9);
    expect(lines[3]).toBe('SOURCE_VERIFICATION_CAPTURED');
  });

  it('bounds contended lock acquisition and releases every earlier SHARE lock on rollback', async () => {
    const blockerRunner = ctx.dataSource.createQueryRunner();
    const verifierRunner = ctx.dataSource.createQueryRunner();
    const observerRunner = ctx.dataSource.createQueryRunner();
    const writerRunner = ctx.dataSource.createQueryRunner();
    let verifierPid = 0;
    try {
      await blockerRunner.connect();
      await blockerRunner.startTransaction('READ COMMITTED');
      await blockerRunner.query(`LOCK TABLE sensor.migrations IN ACCESS EXCLUSIVE MODE`);

      await verifierRunner.connect();
      const verifierPidRows = (await verifierRunner.query(
        `SELECT pg_backend_pid()::integer AS pid`,
      )) as Array<{ pid: number }>;
      verifierPid = verifierPidRows[0]?.pid ?? 0;
      expect(verifierPid).toBeGreaterThan(0);
      await verifierRunner.startTransaction('READ COMMITTED');
      await verifierRunner.query('SET TRANSACTION READ ONLY');

      const startedAt = Date.now();
      const verificationResult = verifierRunner.query(SOURCE_VERIFICATION_SQL).then(
        () => ({ error: null as Error | null }),
        (error: Error) => ({ error }),
      );

      await observerRunner.connect();
      let observedPartialFence = false;
      const observationDeadline = Date.now() + 4_000;
      while (Date.now() < observationDeadline && !observedPartialFence) {
        const rows = (await observerRunner.query(
          `SELECT
             bool_or(
               namespace.nspname = 'admin'
               AND relation.relname = 'tenant_schemas'
               AND locks.mode = 'ShareLock'
               AND locks.granted
             ) AS root_locked,
             bool_or(
               namespace.nspname = 'sensor'
               AND relation.relname = 'migrations'
               AND locks.mode = 'ShareLock'
               AND NOT locks.granted
             ) AS late_relation_waiting
           FROM pg_locks AS locks
           JOIN pg_class AS relation ON relation.oid = locks.relation
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE locks.pid = $1`,
          [verifierPid],
        )) as Array<{ root_locked: boolean; late_relation_waiting: boolean }>;
        observedPartialFence = Boolean(rows[0]?.root_locked && rows[0]?.late_relation_waiting);
        if (!observedPartialFence) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
        }
      }
      expect(observedPartialFence).toBe(true);

      const verification = await verificationResult;
      const elapsedMs = Date.now() - startedAt;
      expect(verification.error?.message).toMatch(/lock timeout/i);
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(10_000);

      await verifierRunner.rollbackTransaction();
      const remainingLocks = (await observerRunner.query(
        `SELECT count(*)::integer AS count
           FROM pg_locks
          WHERE pid = $1
            AND relation IS NOT NULL`,
        [verifierPid],
      )) as Array<{ count: number }>;
      expect(remainingLocks[0]?.count).toBe(0);

      await writerRunner.connect();
      await writerRunner.query(`SET lock_timeout = '500ms'`);
      await expect(writerRunner.query(`UPDATE auth.tenants SET id = id`)).resolves.toBeDefined();
    } finally {
      if (verifierRunner.isTransactionActive) await verifierRunner.rollbackTransaction();
      if (blockerRunner.isTransactionActive) await blockerRunner.rollbackTransaction();
      await verifierRunner.release();
      await blockerRunner.release();
      await observerRunner.release();
      await writerRunner.release();
    }
  }, 20_000);

  it('fails closed on registry drift and holds every canonical writer behind exact SHARE locks', async () => {
    const driftRunner = ctx.dataSource.createQueryRunner();
    const setupRunner = ctx.dataSource.createQueryRunner();
    try {
      await setupRunner.connect();
      await setupRunner.query(
        `INSERT INTO admin.tenant_schemas ("tenantId", "schemaName")
         VALUES ('22222222-2222-4222-8222-222222222222', 'tenant_2222222222224222')`,
      );
      await driftRunner.connect();
      await driftRunner.startTransaction('READ COMMITTED');
      await driftRunner.query('SET TRANSACTION READ ONLY');
      await expect(driftRunner.query(SOURCE_VERIFICATION_SQL)).rejects.toThrow(
        /registry mapping disagrees with canonical tenant identity/i,
      );
      await driftRunner.rollbackTransaction();
      await setupRunner.query(`DELETE FROM admin.tenant_schemas`);
    } finally {
      if (driftRunner.isTransactionActive) await driftRunner.rollbackTransaction();
      await driftRunner.release();
      await setupRunner.release();
    }

    const lockRunner = ctx.dataSource.createQueryRunner();
    const writerRunner = ctx.dataSource.createQueryRunner();
    try {
      await lockRunner.connect();
      await lockRunner.startTransaction('READ COMMITTED');
      await lockRunner.query('SET TRANSACTION READ ONLY');
      await lockRunner.query(SOURCE_VERIFICATION_SQL);

      const captureRows = (await lockRunner.query(
        `SELECT current_setting('aqua.pitr_source_snapshot_id') AS snapshot_id,
                current_setting('aqua.pitr_source_snapshot_sha256') AS snapshot_sha256,
                current_setting('aqua.pitr_source_lock_set_sha256') AS lock_sha256,
                current_setting('aqua.pitr_source_lock_count')::integer AS lock_count,
                current_setting('aqua.pitr_source_lock_relations')::jsonb AS lock_relations,
                current_setting('aqua.pitr_source_completed_at') AS completed_at,
                current_setting('aqua.pitr_recovery_target_time') AS target_at,
                current_setting('aqua.pitr_source_verification_payload')::jsonb AS payload`,
      )) as Array<{
        snapshot_id: string;
        snapshot_sha256: string;
        lock_sha256: string;
        lock_count: number;
        lock_relations: string[];
        completed_at: string;
        target_at: string;
        payload: {
          release: { git_sha: string };
          tenant_schemas: string[];
          sentinels: Array<{ schema: string; table: string; row_count: number }>;
        };
      }>;
      const capture = captureRows[0];
      expect(capture).toBeDefined();
      expect(capture?.snapshot_sha256).toBe(
        createHash('sha256')
          .update(capture?.snapshot_id ?? '')
          .digest('hex'),
      );
      expect(capture?.lock_count).toBe(19);
      expect(capture?.lock_relations).toHaveLength(19);
      expect(capture?.lock_relations).toEqual([...(capture?.lock_relations ?? [])].sort());
      expect(capture?.lock_sha256).toBe(
        createHash('sha256')
          .update((capture?.lock_relations ?? []).join('\n'))
          .digest('hex'),
      );
      expect(capture?.payload.release.git_sha).toBe(MAIN_SHA);
      expect(capture?.payload.tenant_schemas).toEqual([]);
      expect(
        capture?.payload.sentinels.find(
          (sentinel) => sentinel.schema === 'auth' && sentinel.table === 'users',
        )?.row_count,
      ).toBe(1);
      expect(Date.parse(capture?.target_at ?? '') - Date.parse(capture?.completed_at ?? '')).toBe(
        2000,
      );

      await writerRunner.connect();
      await writerRunner.query(`SET lock_timeout = '250ms'`);
      await expect(writerRunner.query(`UPDATE auth.tenants SET id = id`)).rejects.toThrow(
        /lock timeout/i,
      );
      await expect(
        writerRunner.query(
          `INSERT INTO admin.tenant_schemas ("tenantId", "schemaName")
           VALUES ('33333333-3333-4333-8333-333333333333', 'tenant_3333333333334333')`,
        ),
      ).rejects.toThrow(/lock timeout/i);

      await lockRunner.commitTransaction();
      await expect(writerRunner.query(`UPDATE auth.tenants SET id = id`)).resolves.toBeDefined();
    } finally {
      if (lockRunner.isTransactionActive) await lockRunner.rollbackTransaction();
      await lockRunner.release();
      await writerRunner.release();
    }
  }, 30_000);

  it('proves the WAL marker boundary through physical PostgreSQL 16 replica recovery', async () => {
    const scratchDir = mkdtempSync(resolve(tmpdir(), 'aqua-pitr-physical-'));
    const scratchOwner = statSync(scratchDir);
    const archiveDir = resolve(scratchDir, 'archive');
    const baseBackupDir = resolve(scratchDir, 'base-backup');
    const database = 'pitr_contract';
    const username = 'pitr_contract';
    const password = 'pitr-contract-password';
    const markerPrefix = 'aqua.pitr.boundary.v1';
    const fencePrefix = 'aqua.pitr.commit-fence.v1';
    const backupName = 'base_pitr_physical_contract';
    const mainSha = 'b'.repeat(40);
    const runId = 'gha-1000-1';
    let source: StartedPostgreSqlContainer | undefined;
    let target: StartedTestContainer | undefined;
    let targetPostgresStarted = false;
    let proofFailure: Error | undefined;

    mkdirSync(archiveDir, { mode: 0o777 });
    mkdirSync(baseBackupDir, { mode: 0o777 });
    chmodSync(archiveDir, 0o777);
    chmodSync(baseBackupDir, 0o777);

    try {
      source = await new PostgreSqlContainer(DEFAULT_POSTGRES_IMAGE)
        .withDatabase(database)
        .withUsername(username)
        .withPassword(password)
        .withBindMounts([
          { source: archiveDir, target: '/archive', mode: 'rw' },
          { source: baseBackupDir, target: '/base-backup', mode: 'rw' },
        ])
        .withCommand([
          'postgres',
          '-c',
          'wal_level=replica',
          '-c',
          'archive_mode=on',
          '-c',
          'archive_command=cp %p /archive/%f',
          '-c',
          'max_wal_senders=4',
          '-c',
          'synchronous_commit=on',
        ])
        .withStartupTimeout(120_000)
        .start();

      const sourcePsql = async (sql: string): Promise<string> => {
        if (!source) throw new Error('PITR physical source is not running');
        const result = await source.exec(
          [
            'psql',
            '-X',
            '-qAt',
            '-v',
            'ON_ERROR_STOP=1',
            '-h',
            '127.0.0.1',
            '-U',
            username,
            '-d',
            database,
            '-c',
            sql,
          ],
          { user: 'postgres', env: { PGPASSWORD: password } },
        );
        if (result.exitCode !== 0) {
          throw new Error(`source psql failed: ${result.stderr || result.output}`);
        }
        return result.stdout.trim();
      };

      const sourceSettings = (
        await sourcePsql(
          `SELECT concat_ws('|',
           current_setting('server_version_num'),
           current_setting('wal_level'),
           current_setting('archive_mode'))`,
        )
      ).split('|');
      expect(Number(sourceSettings[0])).toBeGreaterThanOrEqual(160_000);
      expect(Number(sourceSettings[0])).toBeLessThan(170_000);
      expect(sourceSettings[1]).toBe('replica');
      expect(sourceSettings[2]).toBe('on');

      await sourcePsql(
        `CREATE TABLE public.pitr_physical_probe (
           phase text PRIMARY KEY CHECK (phase IN ('BEFORE', 'AFTER'))
         )`,
      );
      await sourcePsql('CHECKPOINT');
      const baseBackup = await source.exec(
        [
          'pg_basebackup',
          '-h',
          '127.0.0.1',
          '-U',
          username,
          '-D',
          '/base-backup',
          '-Fp',
          '-X',
          'stream',
          '-c',
          'fast',
          '--no-password',
        ],
        { user: 'postgres', env: { PGPASSWORD: password } },
      );
      if (baseBackup.exitCode !== 0) {
        throw new Error(`pg_basebackup failed: ${baseBackup.stderr || baseBackup.output}`);
      }

      const markerContent = (phase: 'BEFORE' | 'AFTER'): string =>
        JSON.stringify({ backup_name: backupName, main_sha: mainSha, phase, run_id: runId });
      const emitTransactionalMarker = async (phase: 'BEFORE' | 'AFTER'): Promise<string[]> => {
        const content = markerContent(phase);
        const output = await sourcePsql(
          `BEGIN;
           SET LOCAL synchronous_commit = on;
           INSERT INTO public.pitr_physical_probe (phase) VALUES (${quoteSqlLiteral(phase)});
           WITH marker AS MATERIALIZED (
             SELECT clock_timestamp() AS emitted_at,
                    pg_logical_emit_message(
                      true,
                      ${quoteSqlLiteral(markerPrefix)},
                      ${quoteSqlLiteral(content)}
                    ) AS marker_lsn
           )
           SELECT concat_ws('|',
             to_char(emitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             marker_lsn::text)
           FROM marker;
           COMMIT;`,
        );
        const fields = output
          .split(/\r?\n/)
          .find((line) => line.includes('|'))
          ?.split('|');
        if (!fields || fields.length !== 2) {
          throw new Error(`transactional marker output is not canonical: ${output}`);
        }
        return fields;
      };
      const emitCommitFence = async (content: string): Promise<string[]> => {
        const output = await sourcePsql(
          `WITH fence AS MATERIALIZED (
             SELECT clock_timestamp() AS emitted_at,
                    pg_logical_emit_message(
                      false,
                      ${quoteSqlLiteral(fencePrefix)},
                      ${quoteSqlLiteral(content)}
                    ) AS fence_lsn
           )
           SELECT concat_ws('|',
             to_char(emitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             fence_lsn::text,
             pg_walfile_name(fence_lsn))
           FROM fence`,
        );
        const fields = output.split('|');
        if (fields.length !== 3) {
          throw new Error(`commit fence output is not canonical: ${output}`);
        }
        return fields;
      };

      const [beforeMarkerAt, beforeMarkerLsn] = await emitTransactionalMarker('BEFORE');
      const [beforeFenceAt, beforeFenceLsn] = await emitCommitFence(markerContent('BEFORE'));
      const capture = (
        await sourcePsql(
          `WITH captured AS MATERIALIZED (
           SELECT clock_timestamp() AS completed_at,
                  pg_current_wal_insert_lsn() AS floor_lsn
         )
         SELECT concat_ws('|',
           to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           floor_lsn::text,
           to_char(
             (completed_at + interval '2 seconds') AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ))
         FROM captured`,
        )
      ).split('|');
      expect(capture).toHaveLength(3);
      const [sourceCompletedAt, sourceFloorLsn, recoveryTargetTime] = capture;

      let sourceCrossedTarget = false;
      const targetDeadline = Date.now() + 10_000;
      while (!sourceCrossedTarget && Date.now() < targetDeadline) {
        sourceCrossedTarget =
          (await sourcePsql(
            `SELECT (clock_timestamp() > ${quoteSqlLiteral(
              recoveryTargetTime ?? '',
            )}::timestamptz)::text`,
          )) === 'true';
        if (!sourceCrossedTarget) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
        }
      }
      expect(sourceCrossedTarget).toBe(true);

      const [afterMarkerAt, afterMarkerLsn] = await emitTransactionalMarker('AFTER');
      const [afterFenceAt, afterFenceLsn, afterFenceWal] = await emitCommitFence(
        markerContent('AFTER'),
      );
      await sourcePsql('SELECT pg_switch_wal()::text');
      const archiveDeadline = Date.now() + 15_000;
      while (
        !existsSync(resolve(archiveDir, afterFenceWal ?? '')) &&
        Date.now() < archiveDeadline
      ) {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      expect(existsSync(resolve(archiveDir, afterFenceWal ?? ''))).toBe(true);

      const beforeMarkerPosition = parsePostgresLsn(beforeMarkerLsn ?? '');
      const beforeFencePosition = parsePostgresLsn(beforeFenceLsn ?? '');
      const sourceFloorPosition = parsePostgresLsn(sourceFloorLsn ?? '');
      const afterMarkerPosition = parsePostgresLsn(afterMarkerLsn ?? '');
      const afterFencePosition = parsePostgresLsn(afterFenceLsn ?? '');
      expect(beforeMarkerPosition < beforeFencePosition).toBe(true);
      if (beforeFencePosition > sourceFloorPosition) {
        throw new Error(
          `source floor ${sourceFloorLsn ?? '<missing>'} precedes BEFORE fence ${beforeFenceLsn ?? '<missing>'}`,
        );
      }
      expect(sourceFloorPosition <= afterMarkerPosition).toBe(true);
      expect(afterMarkerPosition < afterFencePosition).toBe(true);
      expect(Date.parse(recoveryTargetTime ?? '') - Date.parse(sourceCompletedAt ?? '')).toBe(2000);
      expect(Date.parse(beforeMarkerAt ?? '')).toBeLessThanOrEqual(Date.parse(beforeFenceAt ?? ''));
      expect(Date.parse(beforeFenceAt ?? '')).toBeLessThanOrEqual(
        Date.parse(sourceCompletedAt ?? ''),
      );
      expect(Date.parse(recoveryTargetTime ?? '')).toBeLessThan(Date.parse(afterMarkerAt ?? ''));
      expect(Date.parse(afterMarkerAt ?? '')).toBeLessThanOrEqual(Date.parse(afterFenceAt ?? ''));
      const recoveryTargetMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{6})Z$/.exec(
        recoveryTargetTime ?? '',
      );
      if (!recoveryTargetMatch?.[1] || !recoveryTargetMatch[2]) {
        throw new Error('recovery target is not a canonical PostgreSQL evidence timestamp');
      }
      const postgresRecoveryTargetTime = `${recoveryTargetMatch[1]} ${recoveryTargetMatch[2]}+00`;

      target = await new GenericContainer(DEFAULT_POSTGRES_IMAGE)
        .withUser('root')
        .withEntrypoint(['/bin/bash'])
        .withCommand([
          '-ceu',
          'printf "PITR_TARGET_READY\\n"; trap : TERM INT; while :; do sleep 3600; done',
        ])
        .withBindMounts([
          { source: archiveDir, target: '/archive', mode: 'ro' },
          { source: baseBackupDir, target: '/base-backup', mode: 'rw' },
        ])
        .withWaitStrategy(Wait.forLogMessage(/PITR_TARGET_READY/))
        .withStartupTimeout(120_000)
        .start();

      const configured = await target.exec(
        [
          'bash',
          '-ceu',
          `config=/base-backup/postgresql.auto.conf
           target_time=$1
           {
             printf '%s\\n' "restore_command = 'cp /archive/%f %p'"
             printf "recovery_target_time = '%s'\\n" "${'$'}{target_time}"
             printf '%s\\n' "recovery_target_inclusive = 'off'"
             printf '%s\\n' "recovery_target_timeline = 'latest'"
             printf '%s\\n' "recovery_target_action = 'promote'"
             printf '%s\\n' "archive_mode = 'off'"
           } >> "${'$'}{config}"
           touch /base-backup/recovery.signal
           chown -R postgres:postgres /base-backup
           chmod 0700 /base-backup
           mkdir -p /tmp/pitr-target-socket
           chown postgres:postgres /tmp/pitr-target-socket`,
          'bash',
          postgresRecoveryTargetTime,
        ],
        { user: 'root' },
      );
      if (configured.exitCode !== 0) {
        throw new Error(`target recovery configuration failed: ${configured.stderr}`);
      }

      const targetStart = await target.exec(
        [
          'pg_ctl',
          '-D',
          '/base-backup',
          '-l',
          '/tmp/pitr-target.log',
          '-o',
          "-c listen_addresses='' -c unix_socket_directories='/tmp/pitr-target-socket' -c port=55432",
          '-w',
          'start',
        ],
        { user: 'postgres' },
      );
      if (targetStart.exitCode !== 0) {
        const targetLog = await target.exec(['bash', '-ceu', 'cat /tmp/pitr-target.log'], {
          user: 'root',
        });
        throw new Error(
          `physical recovery target failed to start: ${targetStart.stderr}\n${targetLog.output}`,
        );
      }
      targetPostgresStarted = true;

      const targetPsql = async (sql: string): Promise<string> => {
        if (!target) throw new Error('PITR physical target is not running');
        const result = await target.exec(
          [
            'psql',
            '-X',
            '-qAt',
            '-v',
            'ON_ERROR_STOP=1',
            '-h',
            '/tmp/pitr-target-socket',
            '-p',
            '55432',
            '-U',
            username,
            '-d',
            database,
            '-c',
            sql,
          ],
          { user: 'postgres' },
        );
        if (result.exitCode !== 0) {
          throw new Error(`target psql failed: ${result.stderr || result.output}`);
        }
        return result.stdout.trim();
      };

      expect(
        await targetPsql(`SELECT string_agg(phase, ',' ORDER BY phase) FROM pitr_physical_probe`),
      ).toBe('BEFORE');
      const targetEvidence = (
        await targetPsql(
          `SELECT concat_ws('|',
           pg_is_in_recovery()::text,
           pg_last_wal_replay_lsn()::text,
           to_char(
             current_setting('recovery_target_time')::timestamptz AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ),
           current_setting('recovery_target_inclusive'),
           current_setting('recovery_target_timeline'),
           current_setting('recovery_target_action'))`,
        )
      ).split('|');
      expect(targetEvidence).toHaveLength(6);
      expect(targetEvidence[0]).toBe('false');
      expect(targetEvidence[2]).toBe(recoveryTargetTime);
      expect(targetEvidence[3]).toBe('off');
      expect(targetEvidence[4]).toBe('latest');
      expect(targetEvidence[5]).toBe('promote');
      const restoredReplayLsn = parsePostgresLsn(targetEvidence[1] ?? '');
      expect(beforeMarkerPosition < beforeFencePosition).toBe(true);
      expect(beforeFencePosition <= sourceFloorPosition).toBe(true);
      expect(sourceFloorPosition <= restoredReplayLsn).toBe(true);
      expect(restoredReplayLsn < afterFencePosition).toBe(true);
    } catch (error) {
      proofFailure =
        error instanceof Error
          ? error
          : new Error('PITR physical proof failed with a non-Error value');
    }

    let cleanupFailure: Error | undefined;
    const recordCleanupFailure = (message: string, detail?: unknown): void => {
      if (cleanupFailure !== undefined) return;
      const suffix =
        detail instanceof Error
          ? `: ${detail.message}`
          : typeof detail === 'string'
            ? `: ${detail}`
            : detail === undefined
              ? ''
              : ': non-Error cleanup detail';
      cleanupFailure = new Error(`${message}${suffix}`);
    };

    if (target && targetPostgresStarted) {
      try {
        const stopped = await target.exec(
          ['pg_ctl', '-D', '/base-backup', '-m', 'fast', '-w', 'stop'],
          { user: 'postgres' },
        );
        if (stopped.exitCode !== 0) {
          recordCleanupFailure(
            'PITR target PostgreSQL did not stop cleanly',
            stopped.stderr || stopped.output,
          );
        }
      } catch (error) {
        recordCleanupFailure('PITR target PostgreSQL stop failed', error);
      }
    }

    if (target !== undefined) {
      try {
        await target.stop();
      } catch (error) {
        recordCleanupFailure('PITR target container stop failed', error);
      }
    }

    if (source !== undefined) {
      const hostOwner = `${scratchOwner.uid}:${scratchOwner.gid}`;
      try {
        const restored = await source.exec(['chown', '-R', hostOwner, '/base-backup'], {
          user: 'root',
        });
        if (restored.exitCode !== 0) {
          recordCleanupFailure(
            'could not restore PITR bind-mount ownership',
            restored.stderr || restored.output,
          );
        }
      } catch (error) {
        recordCleanupFailure('could not restore PITR bind-mount ownership', error);
      }
      try {
        await source.stop();
      } catch (error) {
        recordCleanupFailure('PITR source container stop failed', error);
      }
    }

    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch (error) {
      recordCleanupFailure('PITR host scratch cleanup failed', error);
    }
    if (proofFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [proofFailure, cleanupFailure],
        'PITR physical proof and teardown both failed',
      );
    }
    if (proofFailure !== undefined) throw proofFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    expect(existsSync(scratchDir)).toBe(false);
  }, 180_000);
});
