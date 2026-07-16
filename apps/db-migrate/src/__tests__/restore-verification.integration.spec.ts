import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  bootPostgresContainer,
  DEFAULT_POSTGRES_IMAGE,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import {
  bootstrapCreatedSchemas,
  migrationRunnerSchemas,
  tenantAwareSchemas,
} from '@platform/service-catalog';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { QueryRunner } from 'typeorm';

import {
  GLOBAL_SENTINELS,
  TENANT_SENTINELS,
} from '../../../../tools/scripts/database/generate-database-verification-sql';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const VERIFICATION_SQL = readFileSync(
  resolve(REPO_ROOT, 'tools/scripts/database/database-verification.sql'),
  'utf8',
);
const BACKUP_SCRIPT = resolve(REPO_ROOT, 'tools/scripts/database/backup-databases.sh');
const RESTORE_SCRIPT = resolve(REPO_ROOT, 'tools/scripts/database/restore-databases.sh');
const TENANT_ID = '01234567-89ab-cdef-0123-456789abcdef';
const TENANT_SCHEMA = 'tenant_0123456789abcdef';
const RELEASE_ID = 'restore-verification-test';
const RESTORE_TARGET_LABEL = 'com.aqua-saas.restore.role';

interface SentinelProof {
  scope: 'global' | 'tenant';
  schema: string;
  table: string;
  row_count: number;
  checksum: string;
}

interface VerificationPayload {
  contract_version: number;
  canonical_schemas: string[];
  tenant_schemas: string[];
  release: { release_id: string; git_sha: string };
  migration_heads: {
    schemas: Array<{ schema: string; timestamp: string; name: string }>;
    tenants: Array<{
      tenant_schema: string;
      source_schema: string;
      timestamp: string;
      name: string;
    }>;
  };
  sentinels: SentinelProof[];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe test identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function sourceHead(sourceSchema: string): { timestamp: string; name: string } {
  const index = migrationRunnerSchemas().indexOf(sourceSchema);
  if (index < 0) throw new Error(`Unknown source schema: ${sourceSchema}`);
  return {
    timestamp: String(1900000000000 + index),
    name: `Migration${sourceSchema.replace(/(^|_)([a-z])/g, (_match, _prefix, letter: string) => letter.toUpperCase())}`,
  };
}

function expectedHeads(includeTenant = true): Record<string, unknown> {
  const schemas = Object.fromEntries(
    migrationRunnerSchemas().map((schema) => [schema, sourceHead(schema)]),
  );
  const tenants = includeTenant
    ? {
        [TENANT_SCHEMA]: Object.fromEntries(
          tenantAwareSchemas().map((schema) => [schema, sourceHead(schema)]),
        ),
      }
    : {};
  return { schemas, tenants };
}

function tenantFanout(): Record<string, unknown> {
  return Object.fromEntries(
    tenantAwareSchemas().map((schema) => [
      schema,
      { tenants: { [TENANT_SCHEMA]: { status: 'applied' } } },
    ]),
  );
}

describe('database restore verification SQL', () => {
  let ctx: HarnessContext;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  beforeEach(async () => {
    const qr = ctx.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const priorTenantRows = (await qr.query(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ESCAPE '\\'`,
      )) as Array<{ nspname: string }>;
      const schemas = [
        ...bootstrapCreatedSchemas(),
        'platform',
        ...priorTenantRows.map((row) => row.nspname),
      ];
      await qr.query(
        `DROP SCHEMA IF EXISTS ${[...new Set(schemas)].map(quoteIdentifier).join(', ')} CASCADE`,
      );
      for (const schema of [...bootstrapCreatedSchemas(), 'platform', TENANT_SCHEMA]) {
        await qr.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      }

      for (const schema of migrationRunnerSchemas()) {
        const head = sourceHead(schema);
        await qr.query(
          `CREATE TABLE ${quoteIdentifier(schema)}.migrations (
             id SERIAL PRIMARY KEY,
             "timestamp" BIGINT NOT NULL,
             name TEXT NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO ${quoteIdentifier(schema)}.migrations ("timestamp", name) VALUES ($1, $2)`,
          [head.timestamp, head.name],
        );
      }

      for (const schema of tenantAwareSchemas()) {
        const head = sourceHead(schema);
        const table = `migrations_${schema}`;
        await qr.query(
          `CREATE TABLE ${quoteIdentifier(TENANT_SCHEMA)}.${quoteIdentifier(table)} (
             id SERIAL PRIMARY KEY,
             "timestamp" BIGINT NOT NULL,
             name TEXT NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO ${quoteIdentifier(TENANT_SCHEMA)}.${quoteIdentifier(table)} ("timestamp", name) VALUES ($1, $2)`,
          [head.timestamp, head.name],
        );
      }

      for (const sentinel of GLOBAL_SENTINELS) {
        if (sentinel.schema === 'auth' && sentinel.table === 'tenants') {
          await qr.query(
            `CREATE TABLE auth.tenants (
               id UUID PRIMARY KEY,
               status TEXT NOT NULL,
               value TEXT NOT NULL
             )`,
          );
          await qr.query(
            `INSERT INTO auth.tenants (id, status, value) VALUES ($1, 'ACTIVE', 'global')`,
            [TENANT_ID],
          );
          continue;
        }
        await qr.query(
          `CREATE TABLE ${quoteIdentifier(sentinel.schema)}.${quoteIdentifier(sentinel.table)} (
             id TEXT PRIMARY KEY,
             value TEXT NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO ${quoteIdentifier(sentinel.schema)}.${quoteIdentifier(sentinel.table)} (id, value) VALUES ($1, $2)`,
          [`${sentinel.schema}.${sentinel.table}.1`, 'global'],
        );
      }

      for (const sentinel of TENANT_SENTINELS) {
        await qr.query(
          `CREATE TABLE ${quoteIdentifier(TENANT_SCHEMA)}.${quoteIdentifier(sentinel.table)} (
             id TEXT PRIMARY KEY,
             value TEXT NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO ${quoteIdentifier(TENANT_SCHEMA)}.${quoteIdentifier(sentinel.table)} (id, value) VALUES ($1, $2)`,
          [`${sentinel.sourceSchema}.${sentinel.table}.1`, 'tenant'],
        );
      }

      await qr.query(
        `CREATE TABLE admin.tenant_schemas (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           "tenantId" UUID NOT NULL,
           "schemaName" TEXT NOT NULL,
           status TEXT NOT NULL
         )`,
      );
      await qr.query(
        `INSERT INTO admin.tenant_schemas ("tenantId", "schemaName", status)
         VALUES ($1, $2, 'active')`,
        [TENANT_ID, TENANT_SCHEMA],
      );

      await qr.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
      await qr.query(
        `CREATE TABLE sensor.restore_verification_metrics (
           observed_at TIMESTAMPTZ NOT NULL,
           id TEXT NOT NULL,
           value DOUBLE PRECISION NOT NULL,
           PRIMARY KEY (observed_at, id)
         )`,
      );
      await qr.query(
        `SELECT create_hypertable(
           'sensor.restore_verification_metrics',
           'observed_at',
           if_not_exists => true
         )`,
      );
      await qr.query(
        `INSERT INTO sensor.restore_verification_metrics (observed_at, id, value)
         VALUES ('2026-07-15T00:00:00Z', 'metric-1', 42.5)`,
      );

      await qr.query(
        `CREATE TABLE platform.release_ledger (
           release_id TEXT PRIMARY KEY,
           git_sha TEXT NOT NULL,
           expected_heads JSONB NOT NULL,
           tenant_fanout JSONB NOT NULL,
           status TEXT NOT NULL,
           started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await qr.query(
        `INSERT INTO platform.release_ledger
           (release_id, git_sha, expected_heads, tenant_fanout, status)
         VALUES ($1, 'test-sha', $2::jsonb, $3::jsonb, 'db_complete')`,
        [RELEASE_ID, JSON.stringify(expectedHeads()), JSON.stringify(tenantFanout())],
      );
    } finally {
      await qr.release();
    }
  }, 30_000);

  async function collect(): Promise<VerificationPayload> {
    const qr: QueryRunner = ctx.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('REPEATABLE READ');
    try {
      await qr.query(VERIFICATION_SQL);
      const rows = (await qr.query(
        `SELECT current_setting('aqua.restore_verification_payload', false) AS payload`,
      )) as Array<{ payload: string }>;
      const payload = rows[0]?.payload;
      if (!payload) throw new Error('Verification SQL produced no payload');
      await qr.rollbackTransaction();
      return JSON.parse(payload) as VerificationPayload;
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  it('produces deterministic canonical, tenant, migration, and sentinel evidence', async () => {
    const first = await collect();
    const second = await collect();

    expect(second).toEqual(first);
    expect(first.contract_version).toBe(1);
    expect(first.canonical_schemas).toEqual(bootstrapCreatedSchemas());
    expect(first.tenant_schemas).toEqual([TENANT_SCHEMA]);
    expect(first.release).toEqual({ release_id: RELEASE_ID, git_sha: 'test-sha' });
    expect(first.migration_heads.schemas).toHaveLength(migrationRunnerSchemas().length);
    expect(first.migration_heads.tenants).toHaveLength(tenantAwareSchemas().length);
    expect(first.sentinels).toHaveLength(GLOBAL_SENTINELS.length + TENANT_SENTINELS.length);
    expect(first.sentinels.every((sentinel) => sentinel.row_count === 1)).toBe(true);
  });

  it('rejects a missing canonical schema', async () => {
    await ctx.dataSource.query('DROP SCHEMA compliance CASCADE');
    await expect(collect()).rejects.toThrow(/required schema.*compliance.*missing/i);
  });

  it('rejects a malformed tenant-prefixed schema instead of silently excluding it', async () => {
    await ctx.dataSource.query('CREATE SCHEMA tenant_not_a_uuid');
    await expect(collect()).rejects.toThrow(/malformed tenant schema.*tenant_not_a_uuid/i);
  });

  it('rejects a registered tenant whose physical schema is missing', async () => {
    await ctx.dataSource.query(`DROP SCHEMA ${quoteIdentifier(TENANT_SCHEMA)} CASCADE`);
    await expect(collect()).rejects.toThrow(/tenant schema registry.*physical namespace/i);
  });

  it('rejects an untracked physical tenant schema', async () => {
    await ctx.dataSource.query('CREATE SCHEMA tenant_fedcba9876543210');
    await expect(collect()).rejects.toThrow(/tenant schema registry.*physical namespace/i);
  });

  it('rejects a registry row whose tenant and schema identifiers disagree', async () => {
    await ctx.dataSource.query(
      `UPDATE admin.tenant_schemas SET "schemaName" = 'tenant_fedcba9876543210'`,
    );
    await expect(collect()).rejects.toThrow(/tenant schema registry mapping/i);
  });

  it('rejects source migration head drift from the release ledger', async () => {
    await ctx.dataSource.query(
      `INSERT INTO farm.migrations ("timestamp", name) VALUES (9999999999999, 'UnexpectedSourceHead')`,
    );
    await expect(collect()).rejects.toThrow(/source migration head mismatch.*farm/i);
  });

  it('rejects tenant migration head drift from the release ledger', async () => {
    await ctx.dataSource.query(
      `INSERT INTO ${quoteIdentifier(TENANT_SCHEMA)}.migrations_farm
         ("timestamp", name) VALUES (9999999999999, 'UnexpectedTenantHead')`,
    );
    await expect(collect()).rejects.toThrow(/tenant migration head mismatch.*farm/i);
  });

  it('uses the release source head for a tenant onboarded after that release', async () => {
    await ctx.dataSource.query(
      `UPDATE platform.release_ledger SET expected_heads = $1::jsonb WHERE release_id = $2`,
      [JSON.stringify(expectedHeads(false)), RELEASE_ID],
    );
    await expect(collect()).resolves.toMatchObject({ tenant_schemas: [TENANT_SCHEMA] });
  });

  it('rejects a release ledger row that omits the tenant-head contract', async () => {
    await ctx.dataSource.query(
      `UPDATE platform.release_ledger
          SET expected_heads = expected_heads - 'tenants'
        WHERE release_id = $1`,
      [RELEASE_ID],
    );
    await expect(collect()).rejects.toThrow(/release.*tenant.*head contract/i);
  });

  it('rejects a missing sentinel relation', async () => {
    await ctx.dataSource.query(`DROP TABLE ${quoteIdentifier(TENANT_SCHEMA)}.farms`);
    await expect(collect()).rejects.toThrow(/sentinel relation.*farms.*missing/i);
  });

  it('changes the count and checksum when sentinel data changes', async () => {
    const before = await collect();
    await ctx.dataSource.query(
      `INSERT INTO ${quoteIdentifier(TENANT_SCHEMA)}.farms (id, value) VALUES ('farm.2', 'changed')`,
    );
    const after = await collect();
    const findFarm = (payload: VerificationPayload): SentinelProof | undefined =>
      payload.sentinels.find(
        (sentinel) =>
          sentinel.scope === 'tenant' &&
          sentinel.schema === TENANT_SCHEMA &&
          sentinel.table === 'farms',
      );

    expect(findFarm(before)).toMatchObject({ row_count: 1 });
    expect(findFarm(after)).toMatchObject({ row_count: 2 });
    expect(findFarm(after)?.checksum).not.toBe(findFarm(before)?.checksum);
  });

  it('runs pg_dump and verification through one exported snapshot in dump-only mode', () => {
    const result = spawnSync('bash', [BACKUP_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        POSTGRES_CONTAINER: ctx.container.getId(),
        POSTGRES_USER: ctx.connectionOptions.username,
        POSTGRES_DB: ctx.connectionOptions.database,
        PGPASSWORD: ctx.connectionOptions.password,
        BACKUP_DUMP_ONLY: 'true',
        MIN_DUMP_BYTES: '1',
        DATABASE_VERIFICATION_SQL: resolve(
          REPO_ROOT,
          'tools/scripts/database/database-verification.sql',
        ),
      },
    });

    expect(result.error).toBeUndefined();
    const output = `${result.stdout}${result.stderr}`;
    if (result.status !== 0) {
      throw new Error(`backup-databases.sh exited ${result.status}:\n${output}`);
    }
    expect(output).toContain('snapshot-bound dump and verification completed; skipping upload');
  });

  it('restores a bound dump through the operator command and proves exact parity', async () => {
    const scratchDir = mkdtempSync(resolve(tmpdir(), 'aqua-restore-proof-'));
    const dumpPath = resolve(scratchDir, 'source.dump');
    const verificationPath = resolve(scratchDir, 'source.dump.verification.json');
    const encryptedDumpPath = `${dumpPath}.gpg`;
    const encryptedVerificationPath = `${verificationPath}.gpg`;
    const gpgHome = resolve(scratchDir, 'gnupg');
    const fakeAwsPath = resolve(scratchDir, 'aws');
    const targetDatabase = 'harness_restore';
    const backupKey = 'pg-backups/test/source.dump.gpg';
    const verificationKey = `${backupKey}.verification.json.gpg`;
    let restoreTarget: StartedTestContainer | undefined;

    try {
      restoreTarget = await new GenericContainer(DEFAULT_POSTGRES_IMAGE)
        .withEnvironment({
          POSTGRES_DB: 'postgres',
          POSTGRES_USER: ctx.connectionOptions.username,
          POSTGRES_PASSWORD: ctx.connectionOptions.password,
        })
        .withLabels({ [RESTORE_TARGET_LABEL]: 'isolated-drill' })
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(120_000)
        .start();

      const dump = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          ctx.container.getId(),
          'pg_dump',
          '-U',
          ctx.connectionOptions.username,
          '-d',
          ctx.connectionOptions.database,
          '--format=custom',
          '--no-owner',
          '--no-privileges',
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      if (dump.status !== 0) {
        throw new Error(`pg_dump fixture failed: ${dump.stderr.toString()}`);
      }
      writeFileSync(dumpPath, dump.stdout);

      const verification = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          ctx.container.getId(),
          'psql',
          '-X',
          '-qAt',
          '-U',
          ctx.connectionOptions.username,
          '-d',
          ctx.connectionOptions.database,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          encoding: 'utf8',
          input: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${VERIFICATION_SQL}\nCOMMIT;\n`,
        },
      );
      if (verification.status !== 0) {
        throw new Error(`verification fixture failed: ${verification.stderr}`);
      }
      writeFileSync(verificationPath, verification.stdout, 'utf8');

      mkdirSync(gpgHome, { mode: 0o700 });
      chmodSync(gpgHome, 0o700);
      const generateKey = spawnSync(
        'gpg',
        [
          '--batch',
          '--homedir',
          gpgHome,
          '--passphrase',
          '',
          '--quick-generate-key',
          'Aqua Restore Test <restore-test@aqua.invalid>',
          'rsa2048',
          'encrypt',
          '0',
        ],
        { encoding: 'utf8' },
      );
      if (generateKey.status !== 0) {
        throw new Error(`GPG fixture key generation failed: ${generateKey.stderr}`);
      }
      const listKey = spawnSync(
        'gpg',
        ['--batch', '--homedir', gpgHome, '--with-colons', '--fingerprint', '--list-secret-keys'],
        { encoding: 'utf8' },
      );
      if (listKey.status !== 0) {
        throw new Error(`GPG fixture fingerprint lookup failed: ${listKey.stderr}`);
      }
      const keyFingerprint = listKey.stdout
        .split('\n')
        .find((line) => line.startsWith('fpr:'))
        ?.split(':')[9];
      if (!keyFingerprint || !/^[A-F0-9]{40}$/.test(keyFingerprint)) {
        throw new Error('GPG fixture did not produce one exact primary-key fingerprint');
      }

      for (const [input, output] of [
        [dumpPath, encryptedDumpPath],
        [verificationPath, encryptedVerificationPath],
      ] as const) {
        const encrypt = spawnSync(
          'gpg',
          [
            '--batch',
            '--yes',
            '--homedir',
            gpgHome,
            '--trust-model',
            'always',
            '--recipient',
            keyFingerprint,
            '--output',
            output,
            '--encrypt',
            input,
          ],
          { encoding: 'utf8' },
        );
        if (encrypt.status !== 0) {
          throw new Error(`GPG fixture encryption failed for ${input}: ${encrypt.stderr}`);
        }
      }

      const dumpBytes = readFileSync(encryptedDumpPath);
      const verificationBytes = readFileSync(encryptedVerificationPath);
      const verificationPayloadBytes = readFileSync(verificationPath);
      const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
      const dumpSha = digest(dumpBytes);
      const verificationSha = digest(verificationBytes);
      const verificationPayloadSha = digest(verificationPayloadBytes);

      writeFileSync(
        fakeAwsPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  KEY=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--key" ]; then KEY="$2"; shift 2; continue; fi
    shift
  done
  if [ "$KEY" = "$FAKE_BACKUP_KEY" ]; then
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$FAKE_DUMP_SIZE" "$FAKE_DUMP_SHA" "$FAKE_VERIFICATION_SHA" "$FAKE_VERIFICATION_PAYLOAD_SHA" "$FAKE_VERIFICATION_SIZE" "$FAKE_VERIFICATION_KEY"
    exit 0
  fi
  if [ "$KEY" = "$FAKE_VERIFICATION_KEY" ]; then
    printf '%s\\t%s\\t%s\\t%s\\n' "$FAKE_VERIFICATION_SIZE" "$FAKE_VERIFICATION_SHA" "$FAKE_VERIFICATION_PAYLOAD_SHA" "$FAKE_DUMP_SHA"
    exit 0
  fi
  exit 9
fi
if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then
  if [ "$3" = "s3://$SPACES_BUCKET/$FAKE_BACKUP_KEY" ]; then
    cp "$FAKE_DUMP_PATH" "$4"
    exit 0
  fi
  if [ "$3" = "s3://$SPACES_BUCKET/$FAKE_VERIFICATION_KEY" ]; then
    cp "$FAKE_VERIFICATION_PATH" "$4"
    exit 0
  fi
fi
exit 9
`,
        'utf8',
      );
      chmodSync(fakeAwsPath, 0o755);

      const result = spawnSync('bash', [RESTORE_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${scratchDir}:${process.env.PATH ?? ''}`,
          GNUPGHOME: gpgHome,
          TARGET_CONTAINER: restoreTarget.getId(),
          TARGET_USER: ctx.connectionOptions.username,
          TARGET_DB: targetDatabase,
          PGPASSWORD: ctx.connectionOptions.password,
          SPACES_BUCKET: 'test-bucket',
          SPACES_ENDPOINT: 'https://spaces.invalid',
          AWS_ACCESS_KEY_ID: 'test-access',
          AWS_SECRET_ACCESS_KEY: 'test-secret',
          BACKUP_KEY: backupKey,
          BACKUP_GPG_KEY: keyFingerprint,
          MAX_RESTORE_SECONDS: '60',
          DATABASE_VERIFICATION_SQL: resolve(
            REPO_ROOT,
            'tools/scripts/database/database-verification.sql',
          ),
          FAKE_BACKUP_KEY: backupKey,
          FAKE_VERIFICATION_KEY: verificationKey,
          FAKE_DUMP_PATH: encryptedDumpPath,
          FAKE_VERIFICATION_PATH: encryptedVerificationPath,
          FAKE_DUMP_SIZE: String(dumpBytes.length),
          FAKE_DUMP_SHA: dumpSha,
          FAKE_VERIFICATION_SIZE: String(verificationBytes.length),
          FAKE_VERIFICATION_SHA: verificationSha,
          FAKE_VERIFICATION_PAYLOAD_SHA: verificationPayloadSha,
        },
      });

      const output = `${result.stdout}${result.stderr}`;
      if (result.status !== 0) {
        throw new Error(`restore-databases.sh exited ${result.status}:\n${output}`);
      }
      expect(output).toContain(`RESTORE_VERIFIED database=${targetDatabase}`);

      const restoredCount = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          restoreTarget.getId(),
          'psql',
          '-X',
          '-qAt',
          '-U',
          ctx.connectionOptions.username,
          '-d',
          targetDatabase,
          '-c',
          `SELECT COUNT(*) FROM ${quoteIdentifier(TENANT_SCHEMA)}.farms`,
        ],
        { encoding: 'utf8' },
      );
      expect(restoredCount.status).toBe(0);
      expect(restoredCount.stdout.trim()).toBe('1');

      const restoredHypertable = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          restoreTarget.getId(),
          'psql',
          '-X',
          '-qAt',
          '-U',
          ctx.connectionOptions.username,
          '-d',
          targetDatabase,
          '-c',
          `SELECT COUNT(*)
             FROM timescaledb_information.hypertables
            WHERE hypertable_schema = 'sensor'
              AND hypertable_name = 'restore_verification_metrics'`,
        ],
        { encoding: 'utf8' },
      );
      expect(restoredHypertable.status).toBe(0);
      expect(restoredHypertable.stdout.trim()).toBe('1');
    } finally {
      if (restoreTarget) await restoreTarget.stop();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }, 180_000);
});
