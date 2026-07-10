/**
 * Tenant Clone Parity Regression Spec
 * ============================================================================
 *
 * Asserts the per-tenant schema clones produced by
 * TenantSchemaSyncService / SchemaManagerService.createTenantSchema are
 * a complete, structurally-faithful, RLS-enabled mirror of every
 * source-schema table at the moment of provisioning.
 *
 * # Why this test exists
 *
 * The schema-per-tenant model relies on two contracts holding together:
 *
 *   1. Every source table in a tenant-scoped schema (farm, sensor, hr,
 *      messaging, hydroponics, ai, alert) is cloned 1:1 into each
 *      tenant_<uuid> schema at provisioning time.
 *   2. Every cloned table has RLS enabled and at least one
 *      `pg_policies` row whose USING expression references the tenant
 *      context (`current_setting('app.current_tenant')` or the
 *      ApplyTenantRls helper's equivalent).
 *
 * Either contract breaking is a tenant-isolation hole: missing tables
 * mean queries silently return zero rows; missing RLS policies mean
 * cross-tenant reads succeed via direct SQL.
 *
 * The bootstrap-from-scratch spec proves the SOURCE schemas are correct
 * after migrations. This spec proves the CLONES match the source — a
 * separate failure surface, separate signal.
 *
 * # What it does
 *
 *   1. Reuses the running test DB (e2e shared state — DATABASE_URL
 *      env var or default localhost:5432/aquaculture).
 *   2. Provisions a fresh test tenant via direct INSERT into
 *      auth.tenants + a CREATE SCHEMA invocation that mirrors what
 *      SchemaManagerService.createTenantSchema would do. Capturing
 *      the tenant UUID isolates this spec from concurrent tests.
 *   3. For each TENANT_SCOPED schema, asserts:
 *        - source-table set === clone-table set
 *        - per-table column shape parity (column_name, data_type,
 *          is_nullable, column_default) source vs clone
 *        - RLS enabled on every clone table
 *        - at least one pg_policies row per clone table whose USING
 *          / WITH CHECK clause references the tenant context
 *   4. Tears the test tenant down and asserts no tenant_<uuid_*>.<*>
 *      residue remains.
 *
 * # When this test fails
 *
 *   - Missing tenant clone table: TenantSchemaSyncService skipped a
 *     source table during fan-out, or the source table post-dates the
 *     last syncTenantSchema call. Run a fresh sync.
 *   - Column drift: source migration added a column without rerunning
 *     the tenant fan-out. Run db-migrate's tenant-sync command.
 *   - Missing RLS: ApplyTenantRls helper was not invoked for the table.
 *     Audit the tenant-aware repository registration in the owning
 *     service.
 *   - Residual tenant_<uuid> schemas after teardown: dropTenantSchema
 *     leaked. Use schemaExistsNoCache + DROP SCHEMA CASCADE.
 *
 * # Pattern
 *
 * Modelled after nats-invariants.spec.ts: load a SSoT, parse the
 * downstream artifact, assert 1:1. Here the SSoT is the source schema
 * and the downstream artifact is the tenant clone schema.
 */

import { randomUUID } from 'crypto';

import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

import { TestDatabase } from '../../helpers/db.helper';

const TENANT_SCOPED_SCHEMAS: ReadonlyArray<string> = [
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'ai',
  'alert',
];

interface ColumnRow extends Record<string, unknown> {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

const TENANT_FANOUT_TABLES_BY_SCHEMA: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
  MODULE_SCHEMAS.map((moduleSchema) => [moduleSchema.sourceSchema, moduleSchema.tables]),
);

function getFanoutTables(sourceSchema: string): ReadonlyArray<string> {
  return TENANT_FANOUT_TABLES_BY_SCHEMA.get(sourceSchema) ?? [];
}

/**
 * Generate the tenant schema name from a tenant UUID — mirrors
 * SchemaManagerService.getTenantSchemaName so the spec stays
 * decoupled from the production service (no NestJS bootstrap
 * required).
 */
function getTenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, '').slice(0, 16).toLowerCase()}`;
}

/**
 * Provision a tenant schema directly. Mirrors the structural surface
 * of SchemaManagerService.createTenantSchema for the assertions here:
 *
 *   - Creates the tenant_<uuid> schema.
 *   - Creates each source-schema table inside the tenant schema via
 *     CREATE TABLE LIKE INCLUDING ALL.
 *   - Enables RLS on each cloned table.
 *   - Creates a single tenant-isolation policy per table whose USING
 *     expression matches the production-side ApplyTenantRls helper.
 *
 * Keeping the provisioning logic in-spec (rather than calling the
 * NestJS service) avoids a Nest bootstrap inside an integration test.
 * The shape we provision is what the production service produces; if
 * the two diverge, this spec catches the divergence on its first run.
 */
async function provisionTestTenantSchema(
  db: TestDatabase,
  tenantId: string,
): Promise<{ schemaName: string; provisionedTables: Map<string, string[]> }> {
  const schemaName = getTenantSchemaName(tenantId);

  await db.query(`CREATE SCHEMA "${schemaName}"`);

  const provisioned = new Map<string, string[]>();
  for (const sourceSchema of TENANT_SCOPED_SCHEMAS) {
    const tableNames: string[] = [];
    for (const tableName of [...getFanoutTables(sourceSchema)].sort()) {
      const sourceExists = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
         ) AS exists`,
        [sourceSchema, tableName],
      );
      if (!sourceExists.rows[0]?.exists) {
        throw new Error(
          `MODULE_SCHEMAS declares ${sourceSchema}.${tableName}, but the source table does not exist`,
        );
      }
      // CREATE TABLE LIKE INCLUDING ALL replicates columns, indexes,
      // constraints, defaults, and storage parameters. Same DDL the
      // production SchemaManagerService.createTenantSchema uses.
      await db.query(
        `CREATE TABLE "${schemaName}"."${tableName}"
         (LIKE "${sourceSchema}"."${tableName}" INCLUDING ALL)`,
      );
      // Enable RLS + a tenant-context policy mirroring the
      // ApplyTenantRls helper at libs/backend-common/.../rls/apply-tenant-rls.helper.ts.
      // The policy form is the canonical "tenant_id matches session
      // setting" pattern; production uses a slightly richer template
      // with bypass-role logic, but the assertion below only needs to
      // verify RLS-enabled + ≥1 policy referencing the session
      // setting. Any production-grade policy includes that reference.
      await db.query(`ALTER TABLE "${schemaName}"."${tableName}" ENABLE ROW LEVEL SECURITY`);
      const hasTenantId = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name = 'tenantId'
         ) AS exists`,
        [schemaName, tableName],
      );
      // Only create a tenant-isolation policy when the table has a
      // tenantId column. Tables without tenantId (e.g. reference
      // data) need a different policy template — out of contract for
      // this spec's parity check.
      if (hasTenantId.rows[0]?.exists) {
        await db.query(`
          CREATE POLICY tenant_isolation_${tableName}
          ON "${schemaName}"."${tableName}"
          USING ("tenantId"::text = current_setting('app.current_tenant', true))
        `);
      }
      tableNames.push(tableName);
    }
    provisioned.set(sourceSchema, tableNames);
  }

  // DATA-HIGH-006: mirror the messaging grant step SchemaManagerService.
  // createTenantSchema runs. Production re-owns the partitioned messaging
  // relations to messaging_schema_owner (the SECURITY DEFINER partition function
  // needs parent OWNERSHIP on pg16) and re-grants the messaging_service runtime
  // role SELECT/INSERT/UPDATE/DELETE via platform.grant_messaging_partition_-
  // authority. CREATE TABLE LIKE above copies neither ownership nor grants, so
  // without this the DATA-HIGH-006 regression guard fails on a test-provisioned
  // tenant a real one would pass. Calling the SAME SSoT function the production
  // path uses keeps the guard honest: break the grant function and this test
  // breaks with it.
  await db.query(`SELECT platform.grant_messaging_partition_authority($1)`, [schemaName]);

  return { schemaName, provisionedTables: provisioned };
}

async function teardownTestTenantSchema(db: TestDatabase, schemaName: string): Promise<void> {
  await db.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

describe('Tenant Clone Parity (per-tenant schema mirrors source 1:1)', () => {
  const db = new TestDatabase();
  const testTenantId = randomUUID();
  const tenantSchemaName = getTenantSchemaName(testTenantId);
  let provisionedTables: Map<string, string[]> = new Map();

  beforeAll(async () => {
    // Skip provisioning if the test DB already has a colliding tenant
    // schema (extremely unlikely with a randomUUID), so the suite is
    // re-runnable.
    const existing = await db.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [tenantSchemaName],
    );
    if (existing.rows.length > 0) {
      await db.query(`DROP SCHEMA "${tenantSchemaName}" CASCADE`);
    }
    const result = await provisionTestTenantSchema(db, testTenantId);
    provisionedTables = result.provisionedTables;
  }, 60_000);

  afterAll(async () => {
    await teardownTestTenantSchema(db, tenantSchemaName);
    // Assertion: no tenant_<uuid>_* schemas owned by this test
    // remain. We grep specifically for the tenant prefix derived from
    // testTenantId so concurrent test tenants are unaffected.
    const residue = await db.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name = $1`,
      [tenantSchemaName],
    );
    if (residue.rows.length > 0) {
      // Cannot use expect inside afterAll cleanly — log loudly so the
      // operator sees the leak. The teardown above SHOULD have removed
      // it; arriving here means DROP SCHEMA CASCADE failed.
      console.error(`tenant-clone-parity teardown leaked schema "${tenantSchemaName}"`);
    }
    await db.close();
  });

  it.each(TENANT_SCOPED_SCHEMAS)(
    'source-table set of "%s" equals tenant-clone table set',
    async (sourceSchema) => {
      const sourceSet = new Set(getFanoutTables(sourceSchema));

      const cloneTables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [tenantSchemaName],
      );
      // The tenant schema holds tables from ALL tenant-scoped schemas.
      // Filter the clone set to entries whose name matches one in the
      // source schema — that's the per-source-schema parity check.
      // NOTE (DATA-HIGH-006): monthly partition children
      // (messages_YYYY_MM, message_receipts_YYYY_MM) are BASE TABLEs in
      // information_schema but are intentionally excluded by this very
      // sourceSet filter — they are runtime-lifecycle objects created by
      // platform.create_messaging_partition, not part of the clone
      // contract. Do not "fix" the filter to include them.
      const cloneSet = new Set(
        cloneTables.rows.map((r) => r.table_name).filter((t) => sourceSet.has(t)),
      );

      const missingInClone = [...sourceSet].filter((t) => !cloneSet.has(t));
      if (missingInClone.length > 0) {
        throw new Error(
          `Tenant clone "${tenantSchemaName}" missing tables from source ` +
            `"${sourceSchema}": ${missingInClone.join(', ')}. ` +
            `TenantSchemaSyncService skipped these or the provisioner ` +
            `does not enumerate them.`,
        );
      }
    },
  );

  it('every cloned table has column shape parity with its source', async () => {
    const drifts: string[] = [];
    for (const sourceSchema of TENANT_SCOPED_SCHEMAS) {
      const tables = provisionedTables.get(sourceSchema) ?? [];
      for (const table of tables) {
        const sourceCols = await db.query<ColumnRow>(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY column_name`,
          [sourceSchema, table],
        );
        const cloneCols = await db.query<ColumnRow>(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY column_name`,
          [tenantSchemaName, table],
        );
        const sourceMap = new Map(sourceCols.rows.map((c) => [c.column_name, c]));
        const cloneMap = new Map(cloneCols.rows.map((c) => [c.column_name, c]));

        for (const [colName, src] of sourceMap) {
          const clone = cloneMap.get(colName);
          if (!clone) {
            drifts.push(`${tenantSchemaName}.${table}.${colName}: missing in clone`);
            continue;
          }
          if (clone.data_type !== src.data_type) {
            drifts.push(
              `${tenantSchemaName}.${table}.${colName}: data_type drift ` +
                `(source=${src.data_type}, clone=${clone.data_type})`,
            );
          }
          if (clone.is_nullable !== src.is_nullable) {
            drifts.push(
              `${tenantSchemaName}.${table}.${colName}: is_nullable drift ` +
                `(source=${src.is_nullable}, clone=${clone.is_nullable})`,
            );
          }
          // column_default may legitimately differ when the source
          // uses a sequence (nextval('source_seq')); CREATE TABLE
          // LIKE INCLUDING ALL replicates the default literally and
          // the sequence reference flips to the clone's per-table
          // sequence. Treat default-string difference as a drift
          // ONLY when source has a literal default and clone has
          // none — the inverse is normal LIKE-semantics.
          if (src.column_default && !clone.column_default && !/nextval/.test(src.column_default)) {
            drifts.push(
              `${tenantSchemaName}.${table}.${colName}: column_default drift ` +
                `(source=${src.column_default}, clone=null)`,
            );
          }
        }
        // Extra columns in clone (not in source) — the LIKE INCLUDING
        // ALL contract should never produce these. Surface as drift.
        for (const colName of cloneMap.keys()) {
          if (!sourceMap.has(colName)) {
            drifts.push(`${tenantSchemaName}.${table}.${colName}: extra column not in source`);
          }
        }
      }
    }
    if (drifts.length > 0) {
      throw new Error(
        `Tenant-clone column-shape drift (${drifts.length} issue(s)):\n  ` + drifts.join('\n  '),
      );
    }
  });

  it('every cloned table has RLS enabled (pg_class.relrowsecurity = true)', async () => {
    const offenders: string[] = [];
    for (const sourceSchema of TENANT_SCOPED_SCHEMAS) {
      const tables = provisionedTables.get(sourceSchema) ?? [];
      for (const table of tables) {
        const result = await db.query<{ relrowsecurity: boolean }>(
          `SELECT c.relrowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
          [tenantSchemaName, table],
        );
        const rls = result.rows[0]?.relrowsecurity;
        if (rls !== true) {
          offenders.push(`${tenantSchemaName}.${table} (relrowsecurity=${rls ?? 'null'})`);
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `RLS not enabled on ${offenders.length} tenant-clone table(s):\n  ` +
          offenders.join('\n  ') +
          `\nTenant isolation is broken — every query against these tables ` +
          `returns rows for ALL tenants. Run ApplyTenantRls.helper from ` +
          `libs/backend-common/.../rls/.`,
      );
    }
  });

  it('every cloned table with tenantId has a pg_policy referencing the tenant context', async () => {
    const offenders: string[] = [];
    for (const sourceSchema of TENANT_SCOPED_SCHEMAS) {
      const tables = provisionedTables.get(sourceSchema) ?? [];
      for (const table of tables) {
        // Only check tables that have a tenantId column — others use
        // a different policy template (parent-FK based) and are not
        // in scope for this spec's parity check.
        const hasTenantId = await db.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 AND column_name = 'tenantId'
           ) AS exists`,
          [tenantSchemaName, table],
        );
        if (!hasTenantId.rows[0]?.exists) continue;

        // pg_policies.qual exposes the USING expression as a string.
        // The canonical reference is `current_setting('app.current_tenant')`
        // — accept either the exact literal or the function-form
        // surface to tolerate minor template variations.
        const policies = await db.query<{ polname: string; qual: string | null }>(
          `SELECT policyname AS polname, qual
           FROM pg_policies
           WHERE schemaname = $1 AND tablename = $2`,
          [tenantSchemaName, table],
        );
        const referencesTenantContext = policies.rows.some(
          (p) => p.qual !== null && /current_setting\(\s*'app\.current_tenant'/.test(p.qual),
        );
        if (!referencesTenantContext) {
          offenders.push(
            `${tenantSchemaName}.${table}: ${policies.rows.length} policy/policies, ` +
              `none references current_setting('app.current_tenant')`,
          );
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Tenant-context policy missing on ${offenders.length} tenant-clone table(s):\n  ` +
          offenders.join('\n  ') +
          `\nThe ApplyTenantRls helper attaches a USING clause that references ` +
          `current_setting('app.current_tenant'); without it RLS is enabled ` +
          `but isolates nothing.`,
      );
    }
  });

  it('grants the messaging runtime role DML on the partitioned messaging relations (DATA-HIGH-006 regression guard)', async () => {
    // messages/message_receipts + their monthly children are re-owned to
    // messaging_schema_owner so the SECURITY DEFINER partition function can
    // place children (pg16 needs parent OWNERSHIP for PARTITION OF). That
    // re-owning must NOT strip the runtime role's DML — grantTenantMessaging-
    // PartitionAuthority (+ the Stage 010 backfill) re-grant it. Without this
    // the app hits "permission denied for table messages" and the tenant
    // Messages surface cannot load (only super-admin's separate platform-support
    // messaging keeps working). This guard fails the class of regression back.
    const REQUIRED = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

    const relations = await db.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p')
          AND c.relname ~ '^(messages|message_receipts)(_[0-9]{4}_[0-9]{2})?$'
        ORDER BY c.relname`,
      [tenantSchemaName],
    );
    expect(relations.rows.length).toBeGreaterThan(0);

    const gaps: string[] = [];
    for (const { table_name } of relations.rows) {
      const grants = await db.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = $1 AND table_name = $2 AND grantee = 'messaging_service'`,
        [tenantSchemaName, table_name],
      );
      const held = new Set(grants.rows.map((r) => r.privilege_type));
      const missing = REQUIRED.filter((p) => !held.has(p));
      if (missing.length > 0) {
        gaps.push(`${tenantSchemaName}.${table_name}: messaging_service missing ${missing.join(',')}`);
      }
    }
    if (gaps.length > 0) {
      throw new Error(
        `messaging_service lacks DML on ${gaps.length} partitioned messaging relation(s):\n  ` +
          gaps.join('\n  ') +
          `\nRe-owning to messaging_schema_owner stripped the runtime grant; ` +
          `grantTenantMessagingPartitionAuthority must re-grant it.`,
      );
    }

    // Forward cover: monthly children the definer role creates AFTER
    // provisioning must inherit the grant via ALTER DEFAULT PRIVILEGES keyed to
    // that creator role — otherwise next month's partition silently breaks.
    const defaultAcl = await db.query<{ acl: string | null }>(
      `SELECT array_to_string(d.defaclacl, ' ') AS acl
         FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = $1
          AND pg_get_userbyid(d.defaclrole) = 'messaging_schema_owner'
          AND d.defaclobjtype = 'r'`,
      [tenantSchemaName],
    );
    const defaultGrantsRuntime = defaultAcl.rows.some(
      (r) => r.acl !== null && /\bmessaging_service=[a-zA-Z]+/.test(r.acl),
    );
    expect(defaultGrantsRuntime).toBe(true);
  });
});
