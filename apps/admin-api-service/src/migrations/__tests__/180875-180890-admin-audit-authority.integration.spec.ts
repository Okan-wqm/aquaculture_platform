import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import {
  ADMIN_AUDIT_APPEND_SQL,
  ADMIN_AUDIT_DATABASE_AUTHORITY,
} from '../../audit/audit-database-authority';
import { EstablishAdminAuditTrustClasses1808750000000 } from '../1808750000000-EstablishAdminAuditTrustClasses';
import { ConsolidateAdminActivityAuthority1808900000000 } from '../1808900000000-ConsolidateAdminActivityAuthority';

const PRETRUST_ROW_ID = '11111111-1111-4111-8111-111111111111';
const HELD_PRETRUST_ROW_ID = '22222222-2222-4222-8222-222222222222';
const RUNTIME_PASSWORD = 'admin-audit-authority-test-only';

interface AuditTrustRow {
  readonly id: string;
  readonly action: string;
  readonly trustClass: string;
  readonly provenance: {
    readonly schemaVersion: string;
    readonly sourceAuthority: string;
    readonly sourceRowId: string;
    readonly sourceRowSha256: string;
    readonly sourceAction?: string;
  } | null;
}

interface ScalarRow {
  readonly value: string | number | null;
}

async function installBaseline(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await queryRunner.query('DROP SCHEMA IF EXISTS admin CASCADE');
  await queryRunner.query('CREATE SCHEMA admin');
  await queryRunner.query(
    'GRANT USAGE ON SCHEMA admin TO admin_service, admin_audit_retention_controller',
  );
  await queryRunner.query(`
    CREATE TYPE admin.audit_logs_severity_enum AS ENUM ('info', 'warning', 'critical')
  `);
  await queryRunner.query(`
    CREATE TABLE admin.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      action varchar(100) NOT NULL,
      "entityType" varchar(50) NOT NULL,
      "entityId" uuid,
      "tenantId" uuid,
      "performedBy" varchar(100) NOT NULL,
      "performedByEmail" varchar(100),
      "ipAddress" inet,
      "userAgent" varchar(500),
      details jsonb,
      "previousValue" jsonb,
      "newValue" jsonb,
      severity admin.audit_logs_severity_enum NOT NULL DEFAULT 'info',
      "requestId" varchar(100),
      "sessionId" varchar(100),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "legalHold" boolean NOT NULL DEFAULT false
    )
  `);
  await queryRunner.query(`
    CREATE FUNCTION admin.audit_logs_prevent_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'admin.audit_logs rows are immutable - UPDATE is not permitted';
    END
    $function$
  `);
  await queryRunner.query(`
    CREATE TRIGGER trg_audit_logs_prevent_update
    BEFORE UPDATE ON admin.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION admin.audit_logs_prevent_update()
  `);
  await queryRunner.query(`
    CREATE TABLE admin.activity_logs (
      id uuid PRIMARY KEY,
      action varchar(100) NOT NULL,
      "entityType" varchar(50),
      "entityId" varchar(100),
      "tenantId" varchar(100),
      "userId" varchar(100),
      "userEmail" varchar(100),
      severity varchar(20),
      "previousValue" jsonb,
      "newValue" jsonb,
      "createdAt" timestamptz NOT NULL
    )
  `);
  await queryRunner.query(`
    CREATE TABLE admin.retention_policies (
      id uuid PRIMARY KEY,
      name varchar(100) NOT NULL,
      "createdBy" varchar(100),
      "createdAt" timestamptz NOT NULL
    )
  `);
}

async function seedLegacyRows(queryRunner: QueryRunner): Promise<string> {
  await queryRunner.query(
    `INSERT INTO admin.audit_logs (
       id, action, "entityType", "performedBy", details, severity, "legalHold", "createdAt"
     ) VALUES
       ($1, 'USER_CREATED', 'User', 'legacy-admin', '{"source":"pretrust"}', 'info', false,
        '2026-01-01T00:00:00Z'),
       ($2, 'USER_DELETED', 'User', 'legacy-admin', '{"source":"pretrust-held"}',
        'warning', true, '2026-01-02T00:00:00Z')`,
    [PRETRUST_ROW_ID, HELD_PRETRUST_ROW_ID],
  );
  await queryRunner.query(`
    INSERT INTO admin.activity_logs (
      id, action, "entityType", "entityId", "tenantId", "userId", "userEmail", severity,
      "previousValue", "newValue", "createdAt"
    ) VALUES (
      '33333333-3333-4333-8333-333333333333',
      'legacy.activity',
      'User',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      'legacy-user',
      'legacy@example.test',
      'warning',
      '{"enabled":false}',
      '{"enabled":true}',
      '2026-01-03T00:00:00Z'
    )
  `);
  await queryRunner.query(`
    INSERT INTO admin.retention_policies (id, name, "createdBy", "createdAt")
    VALUES (
      '66666666-6666-4666-8666-666666666666',
      'legacy-audit-retention',
      'legacy-admin',
      '2026-01-04T00:00:00Z'
    )
  `);
  const rows = (await queryRunner.query(
    `SELECT encode(
       public.digest(convert_to(to_jsonb(audit)::text, 'UTF8'), 'sha256'),
       'hex'
     ) AS value
     FROM admin.audit_logs audit
     WHERE id = $1`,
    [PRETRUST_ROW_ID],
  )) as ScalarRow[];
  const digest = rows[0]?.value;
  if (typeof digest !== 'string') {
    throw new Error('pre-trust digest fixture was not created');
  }
  return digest;
}

async function runMigration(
  queryRunner: QueryRunner,
  migration: { up(runner: QueryRunner): Promise<void> },
): Promise<void> {
  await queryRunner.startTransaction();
  try {
    await migration.up(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}

async function createRuntimeDataSource(harness: HarnessContext): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    username: ADMIN_AUDIT_DATABASE_AUTHORITY.runtimeRole,
    password: RUNTIME_PASSWORD,
    entities: [],
    synchronize: false,
    logging: false,
    extra: { max: 1 },
    name: `admin-audit-runtime-${Date.now()}`,
  });
  await dataSource.initialize();
  return dataSource;
}

function appendParameters(
  action: string,
  performedBy = 'runtime-admin',
): (string | null | Record<string, string>)[] {
  return [
    action,
    'AuditAuthorityIntegration',
    null,
    null,
    performedBy,
    'runtime-admin@example.test',
    '198.51.100.8',
    'admin-audit-authority-integration/1.0',
    { reason: 'executable authority contract' },
    null,
    null,
    'info',
    'audit-authority-request',
    'audit-authority-session',
  ];
}

describe('180875/180890 admin audit authority — real PostgreSQL', () => {
  let harness: HarnessContext | undefined;
  let queryRunner: QueryRunner;
  const runtimeDataSources: DataSource[] = [];

  beforeAll(async () => {
    harness = await bootPostgresContainer({
      startTimeoutMs: 120_000,
      labels: { 'com.aqua-saas.test.role': 'admin-audit-authority' },
    });
    queryRunner = harness.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.query(`CREATE ROLE admin_service LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    await queryRunner.query('CREATE ROLE admin_audit_retention_controller NOLOGIN');
  }, 150_000);

  afterEach(async () => {
    for (const dataSource of runtimeDataSources.splice(0)) {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  });

  afterAll(async () => {
    await queryRunner?.query('DROP SCHEMA IF EXISTS admin CASCADE');
    await queryRunner?.release();
    await shutdownHarness(harness);
  }, 60_000);

  it('classifies every old row, admits only canonical appends, and fences retention deletes', async () => {
    await installBaseline(queryRunner);
    const expectedPretrustDigest = await seedLegacyRows(queryRunner);

    await runMigration(queryRunner, new EstablishAdminAuditTrustClasses1808750000000());
    await runMigration(queryRunner, new ConsolidateAdminActivityAuthority1808900000000());

    const pretrustRows = (await queryRunner.query(
      `SELECT id, action, "trustClass", provenance
       FROM admin.audit_logs
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [PRETRUST_ROW_ID, HELD_PRETRUST_ROW_ID],
    )) as AuditTrustRow[];
    expect(pretrustRows).toHaveLength(2);
    expect(pretrustRows[0]).toMatchObject({
      id: PRETRUST_ROW_ID,
      action: 'USER_CREATED',
      trustClass: 'LEGACY_UNVERIFIED',
      provenance: {
        schemaVersion: 'admin-audit-legacy-provenance.v1',
        sourceAuthority: 'admin.audit_logs.pretrust',
        sourceRowId: PRETRUST_ROW_ID,
        sourceRowSha256: expectedPretrustDigest,
        sourceAction: 'USER_CREATED',
      },
    });
    expect(pretrustRows.every((row) => row.trustClass === 'LEGACY_UNVERIFIED')).toBe(true);

    const importRows = (await queryRunner.query(
      `SELECT id, action, "trustClass", provenance
       FROM admin.audit_logs
       WHERE action IN ('LEGACY_ACTIVITY_IMPORTED', 'LEGACY_RETENTION_POLICY_IMPORTED')
       ORDER BY action`,
    )) as AuditTrustRow[];
    expect(importRows).toHaveLength(2);
    expect(importRows.every((row) => row.trustClass === 'LEGACY_UNVERIFIED')).toBe(true);
    expect(importRows.every((row) => row.provenance?.sourceRowSha256.length === 64)).toBe(true);

    await expect(
      queryRunner.query(`
        INSERT INTO admin.audit_logs (action, "entityType", "performedBy")
        VALUES ('AUDIT_LOG_ACCESSED', 'AuditAuthorityIntegration', 'database-owner')
      `),
    ).rejects.toThrow(/requires canonical append authority/u);

    if (harness === undefined) throw new Error('PostgreSQL harness did not start');
    const runtime = await createRuntimeDataSource(harness);
    runtimeDataSources.push(runtime);
    await expect(
      runtime.query(`
        INSERT INTO admin.audit_logs (
          action, "entityType", "performedBy", "trustClass", provenance
        ) VALUES (
          'AUDIT_LOG_ACCESSED', 'AuditAuthorityIntegration', 'runtime-direct',
          'AUTHORITATIVE_RUNTIME', NULL
        )
      `),
    ).rejects.toThrow(/permission denied/u);

    const appended = (await runtime.query(
      ADMIN_AUDIT_APPEND_SQL,
      appendParameters('AUDIT_LOG_ACCESSED'),
    )) as AuditTrustRow[];
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      action: 'AUDIT_LOG_ACCESSED',
      trustClass: 'AUTHORITATIVE_RUNTIME',
      provenance: null,
    });

    await expect(
      runtime.query(
        ADMIN_AUDIT_APPEND_SQL,
        appendParameters('LEGACY_ACTIVITY_IMPORTED', 'invalid-runtime-writer'),
      ),
    ).rejects.toThrow(/CHK_admin_audit_logs_trust_provenance/u);
    const contextRows = (await runtime.query(
      `SELECT current_setting(
         '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextSetting}',
         true
       ) AS value`,
    )) as ScalarRow[];
    expect([null, '']).toContain(contextRows[0]?.value ?? null);

    await expect(
      runtime.query('DELETE FROM admin.audit_logs WHERE id = $1', [appended[0]?.id]),
    ).rejects.toThrow(/permission denied/u);

    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `SET LOCAL ROLE ${ADMIN_AUDIT_DATABASE_AUTHORITY.retentionControllerRole}`,
      );
      await expect(
        queryRunner.query('DELETE FROM admin.audit_logs WHERE id = $1', [HELD_PRETRUST_ROW_ID]),
      ).rejects.toThrow(/active legal hold/u);
    } finally {
      await queryRunner.rollbackTransaction();
    }

    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `SET LOCAL ROLE ${ADMIN_AUDIT_DATABASE_AUTHORITY.retentionControllerRole}`,
      );
      await queryRunner.query('DELETE FROM admin.audit_logs WHERE id = $1', [appended[0]?.id]);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    }

    const remainingRows = (await queryRunner.query(
      'SELECT count(*)::int AS value FROM admin.audit_logs WHERE id = ANY($1::uuid[])',
      [[HELD_PRETRUST_ROW_ID, appended[0]?.id]],
    )) as ScalarRow[];
    expect(remainingRows[0]?.value).toBe(1);
  });

  it('rolls the trust migration back when classification is interrupted', async () => {
    await installBaseline(queryRunner);
    await seedLegacyRows(queryRunner);
    await queryRunner.query(`
      CREATE FUNCTION admin.reject_audit_classification()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'injected audit classification failure';
      END
      $function$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_reject_audit_classification
      BEFORE UPDATE ON admin.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION admin.reject_audit_classification()
    `);

    await expect(
      runMigration(queryRunner, new EstablishAdminAuditTrustClasses1808750000000()),
    ).rejects.toThrow(/injected audit classification failure/u);

    const trustColumns = (await queryRunner.query(`
      SELECT count(*)::int AS value
      FROM information_schema.columns
      WHERE table_schema = 'admin'
        AND table_name = 'audit_logs'
        AND column_name IN ('trustClass', 'provenance')
    `)) as ScalarRow[];
    expect(trustColumns[0]?.value).toBe(0);
    const triggerRows = (await queryRunner.query(`
      SELECT tgenabled AS value
      FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'admin.audit_logs'::regclass
        AND tgname = 'trg_audit_logs_prevent_update'
    `)) as ScalarRow[];
    expect(triggerRows[0]?.value).toBe('O');
  });

  it('rolls imports and table retirement back when append authority sealing fails', async () => {
    await installBaseline(queryRunner);
    await seedLegacyRows(queryRunner);
    await runMigration(queryRunner, new EstablishAdminAuditTrustClasses1808750000000());
    await queryRunner.query(`
      CREATE FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunction}(
        varchar, varchar, uuid, uuid, varchar, varchar, inet, varchar,
        jsonb, jsonb, jsonb, admin.audit_logs_severity_enum, varchar, varchar
      )
      RETURNS text
      LANGUAGE sql
      AS $function$ SELECT 'injected incompatible return type'::text $function$
    `);

    await expect(
      runMigration(queryRunner, new ConsolidateAdminActivityAuthority1808900000000()),
    ).rejects.toThrow(/cannot change return type/u);

    const authorityTables = (await queryRunner.query(`
      SELECT count(*)::int AS value
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'admin'
        AND relation.relname IN ('activity_logs', 'retention_policies')
        AND relation.relkind = 'r'
    `)) as ScalarRow[];
    expect(authorityTables[0]?.value).toBe(2);
    const importRows = (await queryRunner.query(`
      SELECT count(*)::int AS value
      FROM admin.audit_logs
      WHERE action IN ('LEGACY_ACTIVITY_IMPORTED', 'LEGACY_RETENTION_POLICY_IMPORTED')
    `)) as ScalarRow[];
    expect(importRows[0]?.value).toBe(0);
  });
});
