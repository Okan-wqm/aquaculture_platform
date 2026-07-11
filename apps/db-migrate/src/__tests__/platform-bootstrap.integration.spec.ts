import { resolve } from 'node:path';

import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';

import {
  runPlatformBootstrap,
  resolvePlatformBootstrapSqlDir,
} from '../platform-bootstrap.service';

/**
 * Platform Bootstrap Atom — restart-survive + idempotency integration test (ADR-031).
 *
 * Proves:
 *   1. Phase 0 applies cleanly against an empty database (fresh-PGDATA path).
 *   2. Second invocation against the same DB is a no-op (idempotent contract).
 *   3. DROP SCHEMA → re-run → schemas + functions + shared tables rebuilt
 *      (restart-survive contract — the bug ADR-031 closes).
 *   4. platform.bootstrap_signal row reflects the latest run.
 *
 * # Why this lives in the integration suite, not a unit mock
 *
 * The bootstrap atom's correctness is exclusively about real Postgres
 * behavior: CREATE EXTENSION semantics, AUTHORIZATION clause idempotency,
 * GRANT re-issue semantics, CREATE POLICY drop-then-create cycle, RLS
 * row-level enforcement. Mocking node-postgres would lose every one of
 * those signals — the test would assert what the code does, not what
 * Postgres does in response.
 */

const silentLog = (_record: Record<string, unknown>): void => undefined;

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SQL_DIR = resolvePlatformBootstrapSqlDir(REPO_ROOT);

/**
 * Service-role password env vars Phase 0 Stage 002 (role create) requires.
 * Aligned with SERVICE_ROLES in platform-bootstrap.service.ts — keeping the
 * two lists in sync is a Tier-3 invariant (next bullet: a future code change
 * that adds a 16th role must also add its env var here, else this suite fails).
 */
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

function withServiceRoleEnvs(): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ROLE_PASS_ENVS) {
    saved.set(key, process.env[key]);
    process.env[key] = `test-${key.toLowerCase().replace(/_/g, '-')}-secret`;
  }
  return {
    restore() {
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

const PLATFORM_SCHEMAS = [
  'auth', 'farm', 'sensor', 'hr', 'messaging', 'hydroponics', 'alert',
  'billing', 'notification', 'ai', 'admin', 'observability',
  'event_store', 'config', 'gateway', 'shared',
] as const;

const PLATFORM_FUNCTIONS = [
  'current_tenant_id',
  'set_tenant_id',
  'update_updated_at_column',
  'audit_immutability_guard',
] as const;

const SHARED_SCHEMA_TABLES = [
  'audit_logs',
  'gdpr_data_requests',
  'user_consents',
  'user_permissions',
  'access_logs',
] as const;

describe('platform-bootstrap atom — restart-survive + idempotency (ADR-031)', () => {
  let ctx: HarnessContext;
  let envHandle: { restore: () => void };

  beforeAll(async () => {
    // Fail-fast contract (Tier-1 Make-Impossible): Phase 0 refuses to start
    // without every SERVICE_ROLE password env var present. Provision them
    // BEFORE bootPostgresContainer so a runaway test cannot accidentally
    // pollute the host shell.
    envHandle = withServiceRoleEnvs();
    ctx = await bootPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
    envHandle?.restore();
  }, 30_000);

  async function countRows(query: string, params: unknown[] = []): Promise<number> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rowsRaw: unknown = await qr.query(query, params);
      const rows = Array.isArray(rowsRaw) ? (rowsRaw as Array<{ count: string }>) : [];
      return Number.parseInt(rows[0]?.count ?? '0', 10);
    } finally {
      await qr.release();
    }
  }

  async function countSchemas(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = ANY($1)`,
      [PLATFORM_SCHEMAS as unknown as string[]],
    );
  }

  async function countFunctions(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count
         FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [PLATFORM_FUNCTIONS as unknown as string[]],
    );
  }

  async function countSharedTables(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count FROM pg_tables
        WHERE schemaname = 'shared' AND tablename = ANY($1)`,
      [SHARED_SCHEMA_TABLES as unknown as string[]],
    );
  }

  async function readBootstrapSignal(): Promise<{
    schemaCount: number;
    functionCount: number;
    sharedTableCount: number;
  } | null> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT schema_count, function_count, shared_table_count FROM platform.bootstrap_signal WHERE id = 1`,
      )) as Array<{ schema_count: number; function_count: number; shared_table_count: number }>;
      const r = rows[0];
      if (!r) return null;
      return {
        schemaCount: Number(r.schema_count),
        functionCount: Number(r.function_count),
        sharedTableCount: Number(r.shared_table_count),
      };
    } finally {
      await qr.release();
    }
  }

  async function releaseLedgerColumns(): Promise<string[]> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'platform'
            AND table_name = 'release_ledger'
          ORDER BY ordinal_position`,
      )) as Array<{ column_name: string }>;
      return rows.map((row) => row.column_name);
    } finally {
      await qr.release();
    }
  }

  async function auditLogColumns(): Promise<
    Record<string, { dataType: string; udtName: string; isNullable: string }>
  > {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'shared'
            AND table_name = 'audit_logs'`,
      )) as Array<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
      }>;
      return Object.fromEntries(
        rows.map((row) => [
          row.column_name,
          {
            dataType: row.data_type,
            udtName: row.udt_name,
            isNullable: row.is_nullable,
          },
        ]),
      );
    } finally {
      await qr.release();
    }
  }

  async function auditLogConstraintNames(): Promise<string[]> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT conname
           FROM pg_constraint
          WHERE conrelid = 'shared.audit_logs'::regclass
          ORDER BY conname`,
      )) as Array<{ conname: string }>;
      return rows.map((row) => row.conname);
    } finally {
      await qr.release();
    }
  }

  async function auditLogIndexNames(): Promise<string[]> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'shared'
            AND tablename = 'audit_logs'
          ORDER BY indexname`,
      )) as Array<{ indexname: string }>;
      return rows.map((row) => row.indexname);
    } finally {
      await qr.release();
    }
  }

  async function queryAsRole<T>(
    role: string,
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      await qr.query(`SET ROLE "${role}"`);
      return (await qr.query(query, params)) as T[];
    } finally {
      await qr.query('RESET ROLE');
      await qr.release();
    }
  }

  it('applies cleanly against an empty database', async () => {
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);

    const signal = await readBootstrapSignal();
    expect(signal).not.toBeNull();
    expect(signal?.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(signal?.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(signal?.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await releaseLedgerColumns()).toEqual(
      expect.arrayContaining([
        'release_id',
        'git_sha',
        'expected_heads',
        'applied_heads',
        'tenant_schema_set',
        'tenant_fanout',
        'rollback_attempted',
        'rollback_verified',
        'rollback_failed',
        'status',
      ]),
    );
  }, 90_000);

  it('installs the canonical shared.audit_logs shape required by runtime schema drift gates', async () => {
    const columns = await auditLogColumns();

    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'id',
        'action',
        'resource',
        'resourceId',
        'userId',
        'userEmail',
        'tenantId',
        'schemaName',
        'metadata',
        'ip',
        'userAgent',
        'severity',
        'correlationId',
        'createdAt',
        'legalHold',
        'actorHomeTenantId',
        'actedOnTenantId',
        'method',
        'mfaVerified',
        'result',
        'preStateHash',
        'postStateHash',
        'justification',
        'relatedAuditIds',
      ]),
    );
    expect(columns.tenantId).toMatchObject({ dataType: 'uuid' });
    expect(columns.ip).toMatchObject({ dataType: 'inet' });
    expect(columns.legalHold).toMatchObject({
      dataType: 'boolean',
      isNullable: 'NO',
    });
    expect(columns.mfaVerified).toMatchObject({
      dataType: 'boolean',
      isNullable: 'NO',
    });
    expect(columns.relatedAuditIds).toMatchObject({
      dataType: 'ARRAY',
      udtName: '_uuid',
    });

    expect(await auditLogConstraintNames()).toEqual(
      expect.arrayContaining([
        'chk_audit_logs_method',
        'chk_audit_logs_post_state_hash',
        'chk_audit_logs_pre_state_hash',
        'chk_audit_logs_result',
      ]),
    );
    expect(await auditLogIndexNames()).toEqual(
      expect.arrayContaining([
        'idx_audit_logs_actor_home_tenant_created',
        'idx_audit_logs_acted_on_tenant_created',
        'idx_audit_logs_mfa_verified_created',
      ]),
    );
  }, 30_000);

  it('reconciles legacy duplicate shared.user_consents before installing the unique tuple index', async () => {
    const qr = ctx.dataSource.createQueryRunner();
    const userId = '11111111-1111-4111-8111-111111111111';
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const oldId = '33333333-3333-4333-8333-333333333333';
    const newId = '44444444-4444-4444-8444-444444444444';
    try {
      await qr.query('DROP INDEX IF EXISTS shared."UQ_consent_user_type_version"');
      await qr.query(
        `INSERT INTO shared.user_consents
           (id, "userId", "tenantId", "consentType", granted, version, metadata, "createdAt")
         VALUES
           ($1, $3, $4, 'analytics', false, 'v1', '{"source":"legacy-old"}'::jsonb, '2026-01-01T00:00:00Z'),
           ($2, $3, $4, 'analytics', true,  'v1', '{"source":"legacy-new"}'::jsonb, '2026-01-02T00:00:00Z')`,
        [oldId, newId, userId, tenantId],
      );

      await runPlatformBootstrap({
        database: ctx.connectionOptions,
        sqlDir: SQL_DIR,
        log: silentLog,
        lockTimeoutSeconds: 30,
      });

      const rows = (await qr.query(
        `SELECT id::text,
                granted,
                metadata,
                jsonb_array_length(metadata->'bootstrapDeduplicatedRows') AS archive_count
           FROM shared.user_consents
          WHERE "userId" = $1
            AND "consentType" = 'analytics'
            AND version = 'v1'`,
        [userId],
      )) as Array<{
        id: string;
        granted: boolean;
        metadata: {
          source?: string;
          bootstrapDeduplicatedRows?: Array<{ id: string; granted: boolean; reason: string }>;
        };
        archive_count: number;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: newId,
        granted: true,
        archive_count: 1,
      });
      expect(rows[0]?.metadata.source).toBe('legacy-new');
      expect(rows[0]?.metadata.bootstrapDeduplicatedRows?.[0]).toMatchObject({
        id: oldId,
        granted: false,
        reason: 'duplicate (userId, consentType, version) before UQ_consent_user_type_version',
      });

      const indexRows = (await qr.query(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'shared'
            AND tablename = 'user_consents'
            AND indexname = 'UQ_consent_user_type_version'`,
      )) as Array<{ indexname: string }>;
      expect(indexRows).toHaveLength(1);
    } finally {
      await qr.query('DELETE FROM shared.user_consents WHERE "userId" = $1', [userId]);
      await qr.release();
    }
  }, 90_000);

  it('hardens runtime database privileges after bootstrap', async () => {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const ownerRows = (await qr.query(
        `SELECT n.nspowner::regrole::text AS owner_name, r.rolcanlogin AS owner_can_login
           FROM pg_namespace n
           JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = 'farm'`,
      )) as Array<{ owner_name: string; owner_can_login: boolean }>;
      expect(ownerRows[0]).toEqual({
        owner_name: 'farm_schema_owner',
        owner_can_login: false,
      });

      const dbCreateRows = (await qr.query(
        `SELECT has_database_privilege('farm_service', current_database(), 'CREATE') AS has_create`,
      )) as Array<{ has_create: boolean }>;
      expect(dbCreateRows[0]?.has_create).toBe(false);

      // Compliance schema (INFRA-HIGH-015): cross-service legal-hold
      // registry — owned like `shared`, DML reachable by every runtime
      // role through the 004 default-priv chain. The probe table stands
      // in for compliance.legal_holds, which is created by the admin-api
      // migration chain and therefore does not exist in the
      // bootstrap-from-scratch database.
      const complianceOwnerRows = (await qr.query(
        `SELECT n.nspowner::regrole::text AS owner_name, r.rolcanlogin AS owner_can_login
           FROM pg_namespace n
           JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = 'compliance'`,
      )) as Array<{ owner_name: string; owner_can_login: boolean }>;
      expect(complianceOwnerRows[0]).toEqual({
        owner_name: 'compliance_schema_owner',
        owner_can_login: false,
      });
      // The probe is created by the bootstrap/migration connection role —
      // exactly how compliance.legal_holds lands in production (the
      // admin-api migration chain runs over the db-migrate connection),
      // so the 004 ALTER DEFAULT PRIVILEGES chain (which binds to the
      // creating role) is what grants the services DML below.
      await qr.query('DROP TABLE IF EXISTS compliance.__runtime_privilege_probe');
      await qr.query(
        'CREATE TABLE compliance.__runtime_privilege_probe (id integer PRIMARY KEY)',
      );
      await queryAsRole(
        'messaging_service',
        'INSERT INTO compliance.__runtime_privilege_probe (id) VALUES (1)',
      );
      await queryAsRole(
        'admin_service',
        'SELECT id FROM compliance.__runtime_privilege_probe',
      );
      await expect(
        queryAsRole(
          'messaging_service',
          'CREATE TABLE compliance.__runtime_ddl_probe (id integer)',
        ),
      ).rejects.toThrow(/permission denied/i);

      await qr.query('DROP TABLE IF EXISTS farm.__runtime_privilege_probe');
      await qr.query('CREATE TABLE farm.__runtime_privilege_probe (id integer PRIMARY KEY)');
      await queryAsRole('farm_service', 'INSERT INTO farm.__runtime_privilege_probe (id) VALUES (1)');
      await expect(
        queryAsRole('farm_service', 'ALTER TABLE farm.__runtime_privilege_probe ADD COLUMN forbidden integer'),
      ).rejects.toThrow(/permission denied|must be owner/i);
      await expect(
        queryAsRole('farm_service', 'CREATE TABLE farm.__runtime_ddl_probe (id integer)'),
      ).rejects.toThrow(/permission denied/i);

      // DATA-HIGH-006 closure: the 2026-06-11 DATA-HIGH-005 carve-out
      // (schema CREATE for the messaging runtime) is dissolved — partition
      // DDL now runs exclusively through the Stage-010 SECURITY DEFINER
      // primitive, so the messaging runtime is back to USAGE+DML like every
      // other role. This assertion is the bidirectional lock with the 008
      // SQL: silent re-introduction of the grant fails here.
      const messagingCreateRows = (await qr.query(
        `SELECT has_schema_privilege('messaging_service', 'messaging', 'CREATE') AS has_create`,
      )) as Array<{ has_create: boolean }>;
      expect(messagingCreateRows[0]?.has_create).toBe(false);

      // Counter-probe: the authority did not vanish — it moved to the
      // definer function's owner role.
      const ownerCreateRows = (await qr.query(
        `SELECT has_schema_privilege('messaging_schema_owner', 'messaging', 'CREATE') AS has_create`,
      )) as Array<{ has_create: boolean }>;
      expect(ownerCreateRows[0]?.has_create).toBe(true);

      const farmSchemaCreateRows = (await qr.query(
        `SELECT has_schema_privilege('farm_service', 'farm', 'CREATE') AS has_create`,
      )) as Array<{ has_create: boolean }>;
      expect(farmSchemaCreateRows[0]?.has_create).toBe(false);
    } finally {
      await qr.query('RESET ROLE');
      await qr.query('DROP TABLE IF EXISTS farm.__runtime_privilege_probe');
      await qr.query('DROP TABLE IF EXISTS farm.__runtime_ddl_probe');
      await qr.query('DROP TABLE IF EXISTS compliance.__runtime_privilege_probe');
      await qr.release();
    }
  }, 30_000);

  it('installs the messaging partition definer primitive (DATA-HIGH-006)', async () => {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      // Function exists, is SECURITY DEFINER, owned by the schema-owner
      // role (pg16 requires parent-table OWNERSHIP for PARTITION OF — not
      // just schema CREATE; proven empirically on the pinned production
      // image), and pins search_path.
      const fnRows = (await qr.query(
        `SELECT p.prosecdef,
                p.proowner::regrole::text AS owner_name,
                array_to_string(p.proconfig, ';') AS config
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'platform'
            AND p.proname = 'create_messaging_partition'`,
      )) as Array<{ prosecdef: boolean; owner_name: string; config: string }>;
      expect(fnRows).toHaveLength(1);
      expect(fnRows[0]).toMatchObject({
        prosecdef: true,
        owner_name: 'messaging_schema_owner',
      });
      expect(fnRows[0]?.config).toContain('search_path=pg_catalog, pg_temp');

      // EXECUTE envelope: messaging runtime only; PUBLIC and other
      // runtimes are out.
      const execRows = (await qr.query(
        `SELECT has_function_privilege('messaging_service',
                  'platform.create_messaging_partition(text,text,integer,integer)', 'EXECUTE') AS msg,
                has_function_privilege('farm_service',
                  'platform.create_messaging_partition(text,text,integer,integer)', 'EXECUTE') AS farm`,
      )) as Array<{ msg: boolean; farm: boolean }>;
      expect(execRows[0]).toEqual({ msg: true, farm: false });

      // The messaging parent tables exist only in live schemas — the
      // bootstrap atom runs against an empty database, so create the
      // parent as the owner role exactly like the Baseline DDL does.
      await qr.query(`SET ROLE messaging_schema_owner`);
      await qr.query(
        `CREATE TABLE IF NOT EXISTS messaging.messages (
           id integer, created_at timestamptz NOT NULL
         ) PARTITION BY RANGE (created_at)`,
      );
      await qr.query('RESET ROLE');

      // Smoke: the runtime role creates a partition THROUGH the primitive…
      await queryAsRole(
        'messaging_service',
        `SELECT platform.create_messaging_partition('messaging', 'messages', 2031, 7)`,
      );
      const partRows = (await qr.query(
        `SELECT c.relname
           FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'messaging' AND c.relname = 'messages_2031_07'`,
      )) as Array<{ relname: string }>;
      expect(partRows).toHaveLength(1);

      // …idempotently…
      await queryAsRole(
        'messaging_service',
        `SELECT platform.create_messaging_partition('messaging', 'messages', 2031, 7)`,
      );

      // …while raw DDL and out-of-allowlist calls stay impossible.
      await expect(
        queryAsRole(
          'messaging_service',
          `CREATE TABLE messaging.messages_2031_08 PARTITION OF messaging.messages
             FOR VALUES FROM ('2031-08-01') TO ('2031-09-01')`,
        ),
      ).rejects.toThrow(/permission denied|must be owner/i);
      await expect(
        queryAsRole(
          'messaging_service',
          `SELECT platform.create_messaging_partition('public', 'messages', 2031, 7)`,
        ),
      ).rejects.toThrow(/not in the allowlist/i);
      await expect(
        queryAsRole(
          'messaging_service',
          `SELECT platform.create_messaging_partition('messaging', 'users', 2031, 7)`,
        ),
      ).rejects.toThrow(/not partition-managed/i);
    } finally {
      await qr.query('RESET ROLE');
      await qr.query('DROP TABLE IF EXISTS messaging.messages CASCADE');
      await qr.release();
    }
  }, 30_000);

  it('second invocation is idempotent — no error, same final counts', async () => {
    // First run was applied in the previous test against the same ctx
    // (testcontainer is shared via beforeAll). This call must succeed
    // without error and without changing observable counts.
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);
  }, 90_000);

  it('survives DROP SCHEMA — restart-survive contract', async () => {
    // Drop every per-service schema CASCADE. Roles and extensions
    // remain (cluster-level). This simulates the day-one reset
    // cutover state.
    const dropQr = ctx.dataSource.createQueryRunner();
    try {
      for (const schema of PLATFORM_SCHEMAS) {
        await dropQr.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      // Also drop the platform schema so we observe the signal table
      // recovery path.
      await dropQr.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
    } finally {
      await dropQr.release();
    }

    expect(await countSchemas()).toBe(0);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length); // still in public
    expect(await countSharedTables()).toBe(0);

    // Re-run bootstrap. Should reconstruct everything.
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);

    const signal = await readBootstrapSignal();
    expect(signal?.schemaCount).toBe(PLATFORM_SCHEMAS.length);

    // DATA-HIGH-006: the partition definer primitive lives in `platform`
    // (dropped above) and MUST come back with the same security shape —
    // losing it on a rebuild would resurrect the raw-runtime-DDL pressure
    // the function exists to make impossible.
    const fnQr = ctx.dataSource.createQueryRunner();
    try {
      const fnRows = (await fnQr.query(
        `SELECT p.prosecdef, p.proowner::regrole::text AS owner_name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'platform'
            AND p.proname = 'create_messaging_partition'`,
      )) as Array<{ prosecdef: boolean; owner_name: string }>;
      expect(fnRows).toHaveLength(1);
      expect(fnRows[0]).toEqual({
        prosecdef: true,
        owner_name: 'messaging_schema_owner',
      });
    } finally {
      await fnQr.release();
    }
  }, 120_000);
});

/**
 * Pre-existing initdb artifacts — the production state class.
 *
 * The first invocation of the new bootstrap atom against the production
 * droplet (Run #1113, SHA 984eb61) failed at Phase 0 because the live DB
 * already carried `shared.*` tables, a `tenant_isolation_policy`, and an
 * immutability trigger created by the archived
 * infrastructure/docker/init-scripts/10-shared-schema.sql at the original
 * initdb pass (months before ADR-031 landed).
 *
 * The atom MUST be idempotent against that legacy state. This suite
 * simulates the legacy artifacts BEFORE Phase 0 ever runs and asserts:
 *   1. The bootstrap completes successfully.
 *   2. RLS policy + immutability trigger end in the canonical Phase 0
 *      shape (drop-then-create is the contract from 006-shared-schema-tables.sql).
 *   3. All schema/function/shared-table counts match.
 */
describe('platform-bootstrap atom — pre-existing initdb artifacts (ADR-031 prod state)', () => {
  let ctx: HarnessContext;
  let envHandle: { restore: () => void };

  beforeAll(async () => {
    envHandle = withServiceRoleEnvs();
    ctx = await bootPostgresContainer();

    // Seed the container with the artifacts the archived initdb script
    // 10-shared-schema.sql would have left behind: shared schema, one of
    // the SHARED_SCHEMA_TABLES, an RLS policy, and an immutability
    // trigger. Identical shapes to what's in
    // infrastructure/docker/init-scripts/.archive/10-shared-schema.sql.archived-2026-05-18
    // — pinned to the columns Phase 0 Stage 006 references so the policy
    // body survives the bootstrap re-apply.
    const qr = ctx.dataSource.createQueryRunner();
    try {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS shared`);
      await qr.query(`
        CREATE TABLE IF NOT EXISTS shared.audit_logs (
          id BIGSERIAL PRIMARY KEY,
          tenant_id UUID NOT NULL,
          actor_id UUID,
          action VARCHAR(64) NOT NULL,
          resource_type VARCHAR(64),
          resource_id VARCHAR(128),
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE shared.audit_logs ENABLE ROW LEVEL SECURITY;
      `);
      await qr.query(`
        DROP POLICY IF EXISTS tenant_isolation_policy ON shared.audit_logs;
        CREATE POLICY tenant_isolation_policy ON shared.audit_logs
          USING (tenant_id::text = current_setting('app.current_tenant', true));
      `);
      await qr.query(`
        CREATE OR REPLACE FUNCTION public.audit_immutability_guard()
        RETURNS TRIGGER LANGUAGE plpgsql AS $body$
        BEGIN
          RAISE EXCEPTION 'audit table is append-only';
        END;
        $body$;
        DROP TRIGGER IF EXISTS trg_audit_logs_immutable_update ON shared.audit_logs;
        CREATE TRIGGER trg_audit_logs_immutable_update
          BEFORE UPDATE ON shared.audit_logs
          FOR EACH ROW EXECUTE FUNCTION public.audit_immutability_guard();
      `);
    } finally {
      await qr.release();
    }
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
    envHandle?.restore();
  }, 30_000);

  it('completes successfully when shared schema + RLS policy + immutability trigger already exist', async () => {
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);
  }, 90_000);

  it('installs the infrastructure-ledger RLS policy on shared.audit_logs (ORPHAN-MEDIUM-324)', async () => {
    // shared.audit_logs is a CROSS-TENANT append-only audit ledger written from
    // no-tenant-context paths (Stripe webhook, cross-service admin). Phase 0
    // Stage 006 must give it the canonical infra-ledger pair (append + system
    // read) and NOT tenant_isolation_policy — under the tenant policy the
    // system-written rows were silently RLS-denied. Also exercises the
    // drop-then-create conflict path (the pre-seeded legacy policy is removed).
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows = (await qr.query(
        `SELECT policyname, cmd FROM pg_policies
          WHERE schemaname = 'shared' AND tablename = 'audit_logs'`,
      )) as Array<{ policyname: string; cmd: string }>;
      const names = rows.map((r) => r.policyname);
      expect(names).toContain('infra_ledger_append');
      expect(names).toContain('infra_ledger_read');
      // The category-error tenant policy must be GONE.
      expect(names).not.toContain('tenant_isolation_policy');
      // Immutability: no UPDATE/DELETE policy exists (append + read only).
      const cmds = rows.map((r) => r.cmd);
      expect(cmds).not.toContain('UPDATE');
      expect(cmds).not.toContain('DELETE');
    } finally {
      await qr.release();
    }
  }, 30_000);
});

/**
 * Fail-fast contract for missing service-role password env vars.
 *
 * Tier-1 Make-Impossible: a Phase 0 atom that silently invents a random
 * password for a missing env var produces a service that cannot
 * authenticate, surfacing later as an opaque "auth failed" crash-loop
 * far from the actual configuration miss. This suite asserts the atom
 * REFUSES to proceed and emits a diagnostic that names the missing env.
 */
describe('platform-bootstrap atom — fail-fast on missing service-role password env (ADR-031)', () => {
  let ctx: HarnessContext;
  let envHandle: { restore: () => void };

  beforeAll(async () => {
    envHandle = withServiceRoleEnvs();
    ctx = await bootPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
    envHandle?.restore();
  }, 30_000);

  it('throws with a structured error when AUTH_SERVICE_DB_PASS is missing', async () => {
    const saved = process.env['AUTH_SERVICE_DB_PASS'];
    Reflect.deleteProperty(process.env, 'AUTH_SERVICE_DB_PASS');
    try {
      await expect(
        runPlatformBootstrap({
          database: ctx.connectionOptions,
          sqlDir: SQL_DIR,
          log: silentLog,
          lockTimeoutSeconds: 30,
        }),
      ).rejects.toThrow(/AUTH_SERVICE_DB_PASS.*auth_service/);
    } finally {
      if (saved !== undefined) process.env['AUTH_SERVICE_DB_PASS'] = saved;
    }
  }, 30_000);

  it('throws with a structured error when the env var is empty string', async () => {
    const saved = process.env['MESSAGING_SERVICE_DB_PASS'];
    process.env['MESSAGING_SERVICE_DB_PASS'] = '';
    try {
      await expect(
        runPlatformBootstrap({
          database: ctx.connectionOptions,
          sqlDir: SQL_DIR,
          log: silentLog,
          lockTimeoutSeconds: 30,
        }),
      ).rejects.toThrow(/MESSAGING_SERVICE_DB_PASS/);
    } finally {
      if (saved !== undefined) process.env['MESSAGING_SERVICE_DB_PASS'] = saved;
    }
  }, 30_000);
});
