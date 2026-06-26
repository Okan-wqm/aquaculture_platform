/**
 * Schema Invariants
 * ============================================================================
 *
 * Asserts the architectural invariants established by the 2026-04-14
 * public-schema teardown plan (docs/plans/2026-04-14-...). These are
 * static facts about the database — no service interactions, no tenant
 * fixtures, just SQL against the live test DB.
 *
 * # Why this test exists
 *
 * Before the teardown, services silently leaked tables into `public`
 * because @Entity decorators omitted the `schema:` option. The drift
 * went undetected until services failed to bootstrap RLS and a
 * production multi-tenant isolation hole opened. A CI invariant on the
 * physical schema layout makes that class of regression impossible by
 * construction — any new entity that forgets `schema:` lands in public,
 * the test below fails, the build is rejected.
 *
 * # What it checks
 *
 *   1. `public` schema contains ONLY the migrations meta + PostgreSQL
 *      extension artifacts. Zero application tables.
 *
 *   2. The `shared` schema contains exactly the four genuinely
 *      cross-service tables (audit_logs, gdpr_data_requests,
 *      user_consents, user_permissions).
 *
 *   3. Every table that was moved during P6-P9 lives in its expected
 *      owning schema (and NOT in public).
 *
 * # When this test fails
 *
 *   - A new entity was added without `schema:` → relocate the entity
 *     by adding the missing decorator option.
 *   - A migration moved a table to public for a transition phase →
 *     either complete the move forward in the same PR or update this
 *     test's allowed-list with a justification comment.
 *   - The shared schema acquired or lost a table → either codify the
 *     change in this allow-list (with PR review on the change) or
 *     revert the migration.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';

import { PROTECTED_TABLES } from '@aquaculture/backend-common/constants';
import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';
import { getMetadataArgsStorage } from 'typeorm';

import { TestDatabase } from '../../helpers/db.helper';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const requireEntity = createRequire(__filename);

/**
 * Wave 4-A.2 Dalga 5 — TENANT_SCOPED vs PLATFORM_LEVEL audit lists.
 *
 * Hardcodes the operator's clarification (Dalga-5 brief): exactly
 * which schemas spawn `tenant_<uuid>` clones vs which stay platform-
 * global. The two sets together cover every owned schema in the SaaS
 * topology; their union, plus `shared` + `public`, is the full
 * inventory.
 *
 * - TENANT_SCOPED schemas MUST have at least one tenant_<uuid> clone
 *   in the active test DB (assertion B.5a). The presence of clones
 *   is what makes "schema-per-tenant" visible at the storage layer.
 * - PLATFORM_LEVEL schemas MUST have ZERO tenant_<uuid>.<sametable>
 *   clones (assertion B.5b). A clone of `auth.users` would be a
 *   tenant-isolation hole — auth is the cross-tenant trust anchor
 *   per CLAUDE.md "tenant row placement (D14)".
 */
const TENANT_SCOPED_SCHEMAS: ReadonlyArray<string> = [
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'ai',
  'alert',
];

const PLATFORM_LEVEL_SCHEMAS: ReadonlyArray<string> = [
  'auth',
  'billing',
  'admin',
  'notification',
  'event_store',
  'observability',
  'config',
  'gateway',
  'shared',
];

const TENANT_FANOUT_TABLES_BY_SCHEMA: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
  MODULE_SCHEMAS.map((moduleSchema) => [
    moduleSchema.sourceSchema,
    moduleSchema.tables,
  ]),
);

// The TENANT_SCOPED set is also the allow-list for entities legitimately
// declaring `schema: undefined` (farm-pattern: SchemaManagerService
// routes them at provision time, so the @Entity decorator stays
// schema-agnostic). Any entity outside this allow-list that omits
// `schema:` is a regression — see assertion B.1.
const TENANT_SCOPED_SERVICES: ReadonlySet<string> = new Set([
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'ai-service',
  'alert-engine',
]);

/**
 * Discover entity files under `apps/<service>/src` for static @Entity
 * audit (B.1, B.2). Mirrors the bootstrap-from-scratch helper but lives
 * separately so this spec has no cross-spec import dependency.
 */
function discoverEntityFiles(): Array<{ service: string; file: string }> {
  const out: Array<{ service: string; file: string }> = [];
  const appsRoot = join(REPO_ROOT, 'apps');
  if (!existsSync(appsRoot)) return out;
  for (const svc of readdirSync(appsRoot)) {
    const svcRoot = join(appsRoot, svc, 'src');
    if (!existsSync(svcRoot)) continue;
    const stack: string[] = [svcRoot];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      let entries: string[];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name === 'migrations' || name === '__tests__' || name === 'node_modules') continue;
        const full = join(cur, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && /\.entity\.ts$/.test(name)) {
          out.push({ service: svc, file: full });
        }
      }
    }
  }
  return out;
}

/**
 * Load every @Entity registered with TypeORM by requiring each entity
 * file. Duplicates protection: getMetadataArgsStorage() is a global
 * singleton; we read its `tables` array AFTER all requires complete.
 */
function loadAllEntityTableArgs(): Array<{
  serviceName: string;
  filePath: string;
  schema: string | undefined;
  tableName: string | undefined;
  targetName: string;
}> {
  const files = discoverEntityFiles();
  // Map target class -> the service+file that registered it. We
  // populate this BEFORE require() to attribute drift back to the
  // owning service when getMetadataArgsStorage() reports a target.
  const ownership = new Map<object, { service: string; file: string }>();
  for (const { service, file } of files) {
    let mod: Record<string, unknown>;
    try {
      mod = requireEntity(file) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const v of Object.values(mod)) {
      if (typeof v === 'function' && /^[A-Z]/.test(v.name) && !ownership.has(v)) {
        ownership.set(v, { service, file });
      }
    }
  }

  const storage = getMetadataArgsStorage();
  return storage.tables.map((t) => {
    const target = typeof t.target === 'function' ? (t.target) : null;
    const own = target ? ownership.get(target) : undefined;
    return {
      serviceName: own?.service ?? 'unknown',
      filePath: own?.file ?? '<unknown>',
      schema: t.schema,
      tableName: typeof t.name === 'string' ? t.name : undefined,
      targetName: target?.name ?? 'unknown-target',
    };
  });
}

const ALLOWED_PUBLIC_TABLES = new Set<string>([
  // TypeORM migration ledger — system table, not application data.
  'migrations',
]);

// ORPHAN-179: derive the shared-schema canonical table set from the
// PROTECTED_TABLES SSoT (libs/backend-common/.../protected-tables.ts) instead of
// hand-copying it (this was the 4th unguarded copy). PROTECTED_TABLES already
// carries the `shared.*` entries — audit_logs (7y), gdpr_data_requests,
// user_consents, user_permissions, access_logs (request-level, 90d; survives
// tenant deletion for forensics). One list, no drift.
const SHARED_SCHEMA_TABLES = new Set<string>(
  PROTECTED_TABLES.filter((t) => t.startsWith('shared.')).map((t) =>
    t.slice('shared.'.length),
  ),
);

/**
 * Tables moved out of `public` during P6-P9 of the teardown. Each entry
 * is `[tableName, expectedSchema]` and is asserted both directions:
 * the table EXISTS in expectedSchema and DOES NOT exist in public.
 */
const MOVED_TABLES: Array<[string, string]> = [
  // P6 — low-risk singletons
  ['channel_detection_log', 'sensor'],
  ['device_tokens', 'notification'],
  ['weather_settings', 'farm'],
  // P7 — moderate
  ['sensor_type_definitions', 'sensor'],
  ['feeder_calibrations', 'farm'],
  ['marine_observations', 'farm'],
  ['weather_observations', 'farm'],
  ['notification_logs', 'notification'],
  // P8 — high-complexity
  ['tenant_roles', 'auth'],
  ['employees', 'hr'],
];

/**
 * Messaging service tables — established in their messaging-schema home
 * by the 2026-04-14 messaging-isolation plan (P7 entity decoration).
 * Asserts each of the 17 messaging entities lives in `messaging` and
 * NOT in `public`. Same assertion semantics as MOVED_TABLES.
 */
const MESSAGING_TABLES: Array<[string, string]> = [
  ['channels', 'messaging'],
  ['channel_members', 'messaging'],
  ['messages', 'messaging'],
  ['message_attachments', 'messaging'],
  ['message_receipts', 'messaging'],
  ['message_reactions', 'messaging'],
  ['pinned_messages', 'messaging'],
  ['messaging_outbox', 'messaging'],
  ['retention_policies', 'messaging'],
  ['legal_holds', 'messaging'],
  ['compliance_audit_log', 'messaging'],
  ['message_analysis', 'messaging'],
  ['message_entity_references', 'messaging'],
  ['knowledge_entries', 'messaging'],
  ['embeddings_metadata', 'messaging'],
  ['tenant_ai_settings', 'messaging'],
  ['user_ai_consents', 'messaging'],
];

describe('Schema Invariants (2026-04-14 public-schema teardown)', () => {
  const db = new TestDatabase();

  afterAll(async () => {
    await db.close();
  });

  it('public schema contains no application tables', async () => {
    const result = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    );

    const offenders = result.rows
      .map((r) => r.tablename)
      .filter((name) => !ALLOWED_PUBLIC_TABLES.has(name));

    if (offenders.length > 0) {
      throw new Error(
        `public schema must contain only ${[...ALLOWED_PUBLIC_TABLES].join(', ')}, ` +
          `but found extra tables: ${offenders.join(', ')}. ` +
          `Either move them to their owning service schema (add ` +
          `\`schema: '<owner>'\` to the @Entity decorator + write a ` +
          `SET SCHEMA migration), OR codify them in ALLOWED_PUBLIC_TABLES ` +
          `with a PR review explaining why public ownership is correct.`,
      );
    }
  });

  it('shared schema strict allow-list (B.3) — exactly the 5 canonical cross-service tables', async () => {
    // Wave 4-A.2 Dalga 5 — B.3 strict allow-list at 5 entries.
    // The 5 canonical tables are: audit_logs, gdpr_data_requests,
    // user_consents, user_permissions, access_logs. A 6th requires
    // an ADR per ADR-011 + architectural-arbiter approval (W5
    // `add-shared-table` skill gate — BLOCKER-15).
    const result = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'shared'
       ORDER BY tablename`,
    );

    const found = new Set(result.rows.map((r) => r.tablename));

    const missing = [...SHARED_SCHEMA_TABLES].filter((t) => !found.has(t));
    const extra = [...found].filter((t) => !SHARED_SCHEMA_TABLES.has(t));

    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(`missing: ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        parts.push(`unexpected: ${extra.join(', ')}`);
      }
      throw new Error(
        `shared schema layout drift — ${parts.join('; ')}. ` +
          `The shared schema is the strict allow-list of ${SHARED_SCHEMA_TABLES.size} tables. ` +
          `A 6th cross-service table requires an ADR drafted under docs/adr/ ` +
          `(template at docs/adr/011-schema-ownership-model.md) plus ` +
          `architectural-arbiter approval — see W5 add-shared-table skill gate ` +
          `(BLOCKER-15). Update SHARED_SCHEMA_TABLES only after the ADR lands.`,
      );
    }
  });

  it.each(MOVED_TABLES)(
    'table %s lives in %s schema (not public)',
    async (tableName, expectedSchema) => {
      const result = await db.query<{ schemaname: string }>(
        `SELECT schemaname FROM pg_tables WHERE tablename = $1`,
        [tableName],
      );

      if (result.rows.length === 0) {
        throw new Error(
          `Table "${tableName}" not found in any schema. The P6-P9 ` +
            `migration that moved it from public to ${expectedSchema} may ` +
            `have failed to apply, or the table was dropped without ` +
            `updating MOVED_TABLES.`,
        );
      }

      const locations = result.rows.map((r) => r.schemaname);
      if (locations.includes('public')) {
        throw new Error(
          `Table "${tableName}" still exists in public schema after the ` +
            `teardown should have moved it to ${expectedSchema}. The ` +
            `MovePublicTablesTo<owner> migration may have been rolled back ` +
            `or never applied to this DB.`,
        );
      }
      if (!locations.includes(expectedSchema)) {
        throw new Error(
          `Table "${tableName}" expected in schema "${expectedSchema}" but ` +
            `found only in: ${locations.join(', ')}. ` +
            `Update MOVED_TABLES if the canonical home changed.`,
        );
      }
    },
  );

  it.each(MESSAGING_TABLES)(
    'messaging-service table %s lives in %s schema (not public, not tenant_*)',
    async (tableName, expectedSchema) => {
      // Look only in non-tenant schemas — tenant_<uuid>.<table> clones are
      // a separate concern (managed by TenantSchemaSyncService) and may
      // legitimately exist alongside the source table.
      const result = await db.query<{ schemaname: string }>(
        `SELECT schemaname FROM pg_tables
         WHERE tablename = $1
           AND schemaname NOT LIKE 'tenant\\_%' ESCAPE '\\'
         ORDER BY schemaname`,
        [tableName],
      );

      if (result.rows.length === 0) {
        throw new Error(
          `Messaging table "${tableName}" not found in any non-tenant schema. ` +
            `The 1782300000000-AddTenantIdToMessageChildren or the original ` +
            `1711800000000-CreateMessagingTables migration may have failed to ` +
            `apply, or the table was dropped without updating MESSAGING_TABLES.`,
        );
      }

      const locations = result.rows.map((r) => r.schemaname);
      if (locations.includes('public')) {
        throw new Error(
          `Messaging table "${tableName}" leaked into public schema. ` +
            `Verify the @Entity decorator declares { schema: 'messaging' } — ` +
            `ADR-011 mandates explicit schema decoration on every entity.`,
        );
      }
      if (!locations.includes(expectedSchema)) {
        throw new Error(
          `Messaging table "${tableName}" expected in "${expectedSchema}" but ` +
            `found only in: ${locations.join(', ')}.`,
        );
      }
    },
  );

  // ═════════════════════════════════════════════════════════════════════
  // Wave 4-A.2 Dalga 5 — extended schema invariants (B.1, B.2, B.4, B.5)
  // ═════════════════════════════════════════════════════════════════════

  // B.1 — No-default-public assertion.
  //
  // Every entity table arg in TypeORM's metadata storage MUST either
  // declare `schema:` explicitly OR belong to a service in
  // TENANT_SCOPED_SERVICES. The latter exception exists because the
  // farm-pattern (codified in ADR-011 + the 2026-04-14 doc revision)
  // routes tenant-aware entities through SchemaManagerService at
  // provision time; the @Entity decorator stays schema-agnostic so a
  // single class can be cloned into both the source schema and every
  // tenant_<uuid> schema.
  //
  // Any other entity that omits `schema:` lands in `public` by default
  // — exactly the regression class the 2026-04-14 teardown plan was
  // built to prevent.
  it('B.1 — every entity declares schema: or belongs to a tenant-scoped service', () => {
    const tables = loadAllEntityTableArgs();
    const offenders: string[] = [];
    for (const t of tables) {
      // Skip class-table-inheritance child entities (no name override).
      // Those legitimately inherit the parent's schema.
      if (!t.tableName) continue;
      if (t.schema) continue; // explicit schema — pass.
      if (TENANT_SCOPED_SERVICES.has(t.serviceName)) continue; // farm-pattern.
      offenders.push(
        `${t.serviceName}::${t.targetName} (table=${t.tableName}) at ${t.filePath} ` +
          `omits schema: AND service is not tenant-scoped`,
      );
    }
    if (offenders.length > 0) {
      throw new Error(
        `B.1 default-public regression — ${offenders.length} entity decorator(s) ` +
          `omit \`schema:\` from a non-tenant-scoped service. Add the explicit ` +
          `\`schema: '<owner>'\` option, or move the service into the tenant-scoped ` +
          `allow-list if it actually has tenant-clone semantics.\n  ` +
          offenders.join('\n  '),
      );
    }
  });

  // B.2 — Declared-vs-physical schema parity.
  //
  // For every entity that DOES declare a schema, the table named in
  // information_schema.tables MUST live in that schema. Catches
  // entities that pin the wrong schema (e.g. typo "shared" → "share")
  // — TypeORM accepts the typo silently and routes the table to
  // public if the schema does not yet exist.
  it('B.2 — declared schema matches the table\'s physical schema', async () => {
    const tables = loadAllEntityTableArgs();
    const drifts: string[] = [];
    for (const t of tables) {
      if (!t.schema || !t.tableName) continue; // covered by B.1.
      // Skip @ViewEntity-style metadata — TypeORM tags views with
      // `type: 'view'` but the discovery surface here doesn't carry
      // the type field, so we accept that physical absence is not
      // a B.2 drift signal (covered separately by ViewInvariants).
      const result = await db.query<{ schemaname: string }>(
        `SELECT schemaname FROM pg_tables
         WHERE tablename = $1
           AND schemaname NOT LIKE 'tenant\\_%' ESCAPE '\\'
           AND schemaname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY (schemaname = $2) DESC, schemaname`,
        [t.tableName, t.schema],
      );
      if (result.rows.length === 0) {
        // Table absent in non-tenant schemas — could be a tenant-only
        // table cloned into tenant_<uuid> schemas at provision. Skip
        // the parity check; B.5 covers tenant-clone surface.
        continue;
      }
      const locations = result.rows.map((r) => r.schemaname);
      if (!locations.includes(t.schema)) {
        drifts.push(
          `${t.serviceName}::${t.targetName} declares schema="${t.schema}" but ` +
            `table "${t.tableName}" lives in ${locations.join(', ')}`,
        );
      }
    }
    if (drifts.length > 0) {
      throw new Error(
        `B.2 declared-vs-physical schema drift (${drifts.length}):\n  ` +
          drifts.join('\n  '),
      );
    }
  }, 30_000);

  // B.4 — Per-service schema ownership at the role level.
  //
  // For every service-owned schema in the canonical list, the
  // pg_namespace.nspowner role MUST be `<svc>_service`. The init
  // script (00-init-schemas.sh) creates schemas with explicit
  // AUTHORIZATION clauses; this assertion catches the failure mode
  // where a manual operator creates the schema as the postgres
  // superuser (which sticks ownership on `postgres`, breaking the
  // privilege boundary that schema-per-service security relies on).
  //
  // The owner naming convention is `<svc>_service` — see
  // infrastructure/docker/init-scripts/00-init-schemas.sh lines
  // 89-128. There is no `_role` suffix; the mission spec's nominal
  // pattern `<svc>_service_role` was a phrasing rather than the
  // on-disk convention.
  it.each([
    ['auth', 'auth_service'],
    ['farm', 'farm_service'],
    ['sensor', 'sensor_service'],
    ['hr', 'hr_service'],
    ['messaging', 'messaging_service'],
    ['hydroponics', 'hydroponics_service'],
    ['alert', 'alert_service'],
    ['billing', 'billing_service'],
    ['notification', 'notification_service'],
    ['ai', 'ai_service'],
    ['admin', 'admin_service'],
    ['observability', 'observability_service'],
    ['event_store', 'event_store_service'],
    ['gateway', 'gateway_service'],
  ])('B.4 — schema "%s" is owned by role "%s"', async (schemaName, expectedRole) => {
    const result = await db.query<{ owner: string | null }>(
      `SELECT pg_get_userbyid(nspowner) AS owner
       FROM pg_namespace
       WHERE nspname = $1`,
      [schemaName],
    );
    if (result.rows.length === 0) {
      throw new Error(
        `B.4 schema "${schemaName}" does not exist in pg_namespace. ` +
          `Verify infrastructure/docker/init-scripts/00-init-schemas.sh ` +
          `creates this schema.`,
      );
    }
    const owner = result.rows[0]?.owner;
    if (owner !== expectedRole) {
      throw new Error(
        `B.4 schema "${schemaName}" is owned by "${owner}", expected "${expectedRole}". ` +
          `The init script's CREATE SCHEMA <schema> AUTHORIZATION ${expectedRole} clause ` +
          `did not run, or a manual ALTER SCHEMA OWNER TO <other> reset ownership. ` +
          `Privilege-boundary security depends on this — fix via ` +
          `\`ALTER SCHEMA "${schemaName}" OWNER TO ${expectedRole}\`.`,
      );
    }
  });

  // B.5a — TENANT_SCOPED schemas: each MUST have at least one
  // tenant_<uuid> clone of its source tables in the test DB.
  // Runs only when the test DB has at least one provisioned tenant
  // (the farm-service migration baseline + e2e fixtures provision a
  // smoke tenant). If no tenant exists, the assertion is vacuously
  // satisfied — the bootstrap path doesn't provision tenants by
  // itself.
  it.each(TENANT_SCOPED_SCHEMAS)(
    'B.5a — tenant-scoped schema "%s" has at least one tenant clone (when tenants exist)',
    async (sourceSchema) => {
      // Inventory of tenant clone schemas in the DB.
      const tenantSchemas = await db.query<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'`,
      );
      if (tenantSchemas.rows.length === 0) {
        // No tenants provisioned — assertion vacuously true. Part C
        // spec actively provisions a tenant and runs the same check
        // with stronger preconditions.
        return;
      }
      // Sample one fan-out table from the SchemaManagerService SSoT.
      // Source schemas may also contain source-only infrastructure
      // tables (migrations, outbox, audit ledgers) that must NOT be
      // tenant-cloned.
      const sourceTables = TENANT_FANOUT_TABLES_BY_SCHEMA.get(sourceSchema) ?? [];
      const sampleTable = [...sourceTables].sort()[0];
      if (!sampleTable) {
        // No fan-out tables declared — nothing to clone, nothing to
        // assert. MODULE_SCHEMAS static invariants cover declaration
        // completeness.
        return;
      }
      const cloneCheck = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
         WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
           AND table_name = $1`,
        [sampleTable],
      );
      const cloneCount = parseInt(cloneCheck.rows[0]?.count ?? '0', 10);
      if (cloneCount === 0) {
        throw new Error(
          `B.5a tenant-scoped schema "${sourceSchema}" has source table ` +
            `"${sampleTable}" but ZERO tenant_<uuid> schemas carry a clone of it. ` +
            `TenantSchemaSyncService is not provisioning the table on tenant ` +
            `creation, or every existing tenant predates the table's introduction ` +
            `(in which case run the deploy-time tenant fan-out).`,
        );
      }
    },
  );

  // B.5b — PLATFORM_LEVEL schemas: each MUST have ZERO tenant_<uuid>
  // clones of its tables. A tenant clone of e.g. `auth.users` is a
  // tenant-isolation hole — auth is the cross-tenant trust anchor.
  it.each(PLATFORM_LEVEL_SCHEMAS)(
    'B.5b — platform-level schema "%s" has ZERO tenant_<uuid> clones of its tables',
    async (platformSchema) => {
      const sourceTables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [platformSchema],
      );
      const sourceTableNames = sourceTables.rows.map((r) => r.table_name);
      if (sourceTableNames.length === 0) return;

      const violations = await db.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
           AND table_name = ANY($1::text[])`,
        [sourceTableNames],
      );
      if (violations.rows.length > 0) {
        const sample = violations.rows
          .slice(0, 5)
          .map((r) => `${r.table_schema}.${r.table_name}`)
          .join(', ');
        throw new Error(
          `B.5b platform-level schema "${platformSchema}" has ${violations.rows.length} ` +
            `tenant_<uuid>.<table> clone(s) of its tables — first 5: ${sample}. ` +
            `Platform schemas are global by definition; per-tenant clones violate ` +
            `the trust-boundary model. Investigate which migration or provisioning ` +
            `path created them and remove via DROP TABLE on the offending tenant ` +
            `clones.`,
        );
      }
    },
  );
});
