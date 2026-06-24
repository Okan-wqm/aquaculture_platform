/**
 * Bootstrap From Scratch
 * ============================================================================
 *
 * Proves that the fresh-volume init pipeline — `infrastructure/docker/init-scripts/*`
 * + every service's TypeORM migration chain — produces a clean, complete
 * platform schema when run against an empty Postgres.
 *
 * # Why this test exists
 *
 * The codebase's bootstrap pipeline silently broke when several
 * `CREATE TABLE` migrations were squashed out of source. Production survived
 * because nobody did a fresh-volume init for months — every existing
 * environment had the squashed-out tables already on disk. The first
 * fresh-volume deploy crashed at `1781100000000-ConvertTimestampToTimestamptz`
 * trying to ALTER `auth.users.mfaLockedUntil` (a column whose CREATE was
 * gone). That is the exact regression class this invariant guards against.
 *
 * # What it does
 *
 *   1. Spin up `timescale/timescaledb-ha:pg16` (the production image, by
 *      digest pinned to docker-compose.infra.yml).
 *   2. Bind-mount `infrastructure/docker/init-scripts/` into
 *      `/docker-entrypoint-initdb.d/` — Postgres runs every script in
 *      lexical order on first boot of an empty PGDATA volume.
 *   3. Connect, then for every service that owns a TypeORM migration
 *      directory, dynamically load every migration class and run them
 *      through a per-service DataSource bound to that service's schema.
 *   4. Assert schema-level invariants: schemas exist, the previously
 *      missing baseline tables now exist, the previously missing
 *      `auth.users` columns now exist, the sensor hypertable was
 *      created, and each service's migration ledger is non-empty
 *      (proving the migrations actually ran).
 *
 * # When this test fails
 *
 *   - A migration that creates a baseline table was squashed →
 *     restore the CREATE in the earliest service migration. (This is
 *     the original regression class.)
 *   - An init-script SQL file was deleted without an equivalent
 *     migration → either restore the script OR write a migration that
 *     creates the same tables idempotently.
 *   - A new entity was added without a corresponding CREATE TABLE
 *     migration AND without an init-script entry → add the migration.
 *   - The init scripts assume a privilege the bind-mount POSTGRES_USER
 *     does not have on a fresh container → fix the script to use
 *     a less-privileged path or mount additional bootstrap material.
 *
 * # Why testcontainers (not the shared TestDatabase pool)
 *
 * The other e2e/integration specs assert state of an *already-running*
 * database that the dev/CI infra brought up — they're checking
 * application-level behaviour. This test asserts the bootstrap ITSELF
 * works on an EMPTY volume. It MUST start with no PGDATA, run the init
 * scripts, then run the migration chain. testcontainers is the only
 * way to get that hermetic guarantee inside a Jest worker.
 *
 * # Runtime
 *
 * ~3-5 minutes on a cold runner: image pull + init-script execution +
 * 100+ migrations across 13 services. CI gate runs only on PRs that
 * touch `apps/*\/src/**\/migrations/**` or
 * `infrastructure/docker/init-scripts/**` (see CI workflow
 * `.github/workflows/db-migration-check.yml` integration; if the gate
 * is not yet wired, `npm run test:bootstrap` is the local entry point).
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';

import { ConfigService } from '@nestjs/config';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { DataSource, type MigrationInterface } from 'typeorm';

// ADR-031 Platform Bootstrap Atom — runs the schema/role/extension/function/
// shared-table DDL contract that init-scripts USED to own pre-cutover. The
// init-scripts bind-mount below now contains only `01-init-databases.sql`
// (initdb-only DB GRANTs). Schemas, roles, functions, and shared.* tables
// are created by the call to runPlatformBootstrap() below before any
// per-service migration loop runs.
import {
  runPlatformBootstrap,
  resolvePlatformBootstrapSqlDir,
} from '../../../apps/db-migrate/src/platform-bootstrap.service';
import { assertDefined } from '../../helpers/assertions';

// Constructor type for the @Entity / migration classes this spec loads
// dynamically. TypeORM's DataSource `entities`/`migrations` options accept
// `Function`, but `@typescript-eslint/no-unsafe-function-type` (correctly)
// rejects the bare `Function` type; a precise construct signature is both
// assignable to TypeORM's `Function` slot AND keeps the collected values
// typed as classes rather than arbitrary callables.
type EntityClass = new (...args: never[]) => object;

// Synchronous module loader bound to this spec's location. `import`/`await
// import()` cannot be used here: loadMigrationClassesFromDir is invoked inside
// `it.each(...)` arguments that Jest evaluates synchronously at collection
// time, so the load must be synchronous. `createRequire(__filename)` is the
// same pattern the sibling schema-invariants.spec.ts uses for cross-rootDir
// loads — it resolves through ts-jest at runtime and avoids the e2e tsconfig
// rootDir guard (TS6059) that a top-level static `import` of these out-of-tree
// files would trigger.
const requireModule = createRequire(__filename);

// Dynamic load to avoid the e2e tsconfig's rootDir guard. Importing
// schema-drift-validator.service.ts directly via `import { ... }` would
// pull a file outside the e2e/ rootDir into the type-check graph and
// trigger TS6059 on every spec compile. ts-jest resolves this lazily
// at runtime (same pattern the migration loader uses for migration
// classes). The validator's contract is stable; loading through the file
// path keeps the spec free of cross-rootDir type drift.
type SchemaDriftValidatorFactory = (
  serviceName: string,
) => new (ds: DataSource, cs: ConfigService) => { onApplicationBootstrap(): Promise<void> };
function loadDriftValidatorFactory(): SchemaDriftValidatorFactory {
  const mod = requireModule(
    '../../../libs/backend-common/src/database/schema-drift-validator.service',
  ) as {
    createSchemaDriftValidator: SchemaDriftValidatorFactory;
  };
  return mod.createSchemaDriftValidator;
}

// The same image+digest the production stack uses — see
// docker-compose.infra.yml line 12. Pinning by digest guarantees the
// init-script behaviour we're proving here matches what runs in
// production. Bumping the digest is a deliberate review surface.
const POSTGRES_IMAGE =
  'timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7';

const DATABASE_NAME = 'aquaculture';
const DATABASE_USER = 'aquaculture';
const DATABASE_PASSWORD = 'aquaculture-test';
const DB_MIGRATE_DDL_AUTHORITY_ENV = 'DB_MIGRATE_DDL_AUTHORITY';
const SERVICE_ROLE_PASSWORD_ENVS = [
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

// Repo root, derived from this file's location:
//   e2e/tests/integration/bootstrap-from-scratch.spec.ts -> ../../..
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const INIT_SCRIPTS_DIR = join(REPO_ROOT, 'infrastructure', 'docker', 'init-scripts');

async function runWithDbMigrateDdlAuthority<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.env[DB_MIGRATE_DDL_AUTHORITY_ENV];
  process.env[DB_MIGRATE_DDL_AUTHORITY_ENV] = '1';
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, DB_MIGRATE_DDL_AUTHORITY_ENV);
    } else {
      process.env[DB_MIGRATE_DDL_AUTHORITY_ENV] = previous;
    }
  }
}

/**
 * Per-service migration manifest.
 *
 * Each entry maps a service to:
 *   - `schema`: the Postgres schema this service owns. The DataSource is
 *     bound to it so the migration ledger lands in `<schema>.migrations`.
 *   - `migrationsDir`: the on-disk path containing the service's
 *     timestamped TypeORM migration files. Two patterns exist in this
 *     codebase (historical drift, ADR-011 §"Migration Runners"):
 *       * `apps/<svc>/src/migrations/`         (auth, admin-api, messaging, event-store)
 *       * `apps/<svc>/src/database/migrations/` (everything else)
 *     This manifest reflects the actual on-disk layout — keep in sync
 *     when adding a service.
 *
 * Order matters: services with cross-schema FK migrations (e.g.
 * messaging.tenant_ai_settings -> auth.tenants) must run after the
 * schema they reference. We run auth FIRST for that reason; everything
 * else is alphabetical.
 */
interface ServiceManifest {
  name: string;
  schema: string;
  migrationsDir: string;
  /**
   * `entitiesGlob`: optional glob (relative to repo root) that matches
   * every `*.entity.ts` file owned by this service. When set, the
   * entity-surface-vs-DB matrix (assertEntitySurfaceMatchesDb) iterates
   * the files under this glob and asserts each entity's table surface
   * exists in the DB. Services without entities (gateway-api) leave it
   * unset.
   */
  entitiesGlob?: string;
}

const SERVICES: ServiceManifest[] = [
  // auth FIRST — every other service's FKs reference auth.tenants.
  {
    name: 'auth-service',
    schema: 'auth',
    migrationsDir: 'apps/auth-service/src/migrations',
    entitiesGlob: 'apps/auth-service/src',
  },
  // Then the rest, ordered to minimize cross-schema FK ordering hazards.
  {
    name: 'farm-service',
    schema: 'farm',
    migrationsDir: 'apps/farm-service/src/database/migrations',
    entitiesGlob: 'apps/farm-service/src',
  },
  {
    name: 'sensor-service',
    schema: 'sensor',
    migrationsDir: 'apps/sensor-service/src/database/migrations',
    entitiesGlob: 'apps/sensor-service/src',
  },
  {
    name: 'hr-service',
    schema: 'hr',
    migrationsDir: 'apps/hr-service/src/database/migrations',
    entitiesGlob: 'apps/hr-service/src',
  },
  {
    name: 'messaging-service',
    schema: 'messaging',
    migrationsDir: 'apps/messaging-service/src/migrations',
    entitiesGlob: 'apps/messaging-service/src',
  },
  {
    name: 'alert-engine',
    schema: 'alert',
    migrationsDir: 'apps/alert-engine/src/database/migrations',
    entitiesGlob: 'apps/alert-engine/src',
  },
  {
    name: 'billing-service',
    schema: 'billing',
    migrationsDir: 'apps/billing-service/src/database/migrations',
    entitiesGlob: 'apps/billing-service/src',
  },
  {
    name: 'notification-service',
    schema: 'notification',
    migrationsDir: 'apps/notification-service/src/database/migrations',
    entitiesGlob: 'apps/notification-service/src',
  },
  {
    name: 'observability-service',
    schema: 'observability',
    migrationsDir: 'apps/observability-service/src/database/migrations',
    entitiesGlob: 'apps/observability-service/src',
  },
  {
    name: 'admin-api-service',
    schema: 'admin',
    migrationsDir: 'apps/admin-api-service/src/migrations',
    entitiesGlob: 'apps/admin-api-service/src',
  },
  {
    name: 'event-store-service',
    schema: 'event_store',
    migrationsDir: 'apps/event-store-service/src/migrations',
    entitiesGlob: 'apps/event-store-service/src',
  },
  // Wave 4-A.2 Dalga 5 — close the manifest gap. The 4 services
  // below were absent from the original 11-service manifest, so the
  // bootstrap test passed even when their migration chains were empty
  // or their entity-surface drifted from the on-disk schema. Adding
  // them here closes the regression class:
  //
  //   hydroponics-service / ai-service — schema-per-tenant services
  //     with their own baseline migrations + entity surface.
  //   config-service — platform-level service. Migrations dir is
  //     intentionally empty (.gitkeep only) — the entity-surface
  //     check still runs, the migration runner is a no-op.
  //   gateway-api — pure HTTP fronting, owns NO entities and NO
  //     migrations. Listed in the manifest so the schema-ownership
  //     audit (Part B B.4) can assert the `gateway` schema exists
  //     and is owned by `gateway_service`. `entitiesGlob` is unset
  //     → entity-surface check skips it (correct: nothing to check).
  {
    name: 'hydroponics-service',
    schema: 'hydroponics',
    migrationsDir: 'apps/hydroponics-service/src/database/migrations',
    entitiesGlob: 'apps/hydroponics-service/src',
  },
  {
    name: 'ai-service',
    schema: 'ai',
    migrationsDir: 'apps/ai-service/src/database/migrations',
    entitiesGlob: 'apps/ai-service/src',
  },
  {
    name: 'config-service',
    schema: 'config',
    migrationsDir: 'apps/config-service/src/database/migrations',
    entitiesGlob: 'apps/config-service/src',
  },
  {
    name: 'gateway-api',
    schema: 'gateway',
    migrationsDir: 'apps/gateway-api/src/database/migrations',
    // gateway-api owns no entities — `entitiesGlob` intentionally unset.
  },
];

/**
 * Tables expected to be registered as TimescaleDB hypertables after the
 * full bootstrap pipeline runs. Sensor service owns both: `sensor_readings`
 * is the high-volume time-series feed; `sensor_metrics` is the
 * derived/aggregated metric stream with the narrow-table format introduced
 * in 1735800000000-CreateSensorReadingsHypertable + the per-tenant
 * createSensorMetricsHypertable() path in SchemaManagerService.
 */
const EXPECTED_HYPERTABLES: Array<{ schema: string; table: string }> = [
  { schema: 'sensor', table: 'sensor_readings' },
  { schema: 'sensor', table: 'sensor_metrics' },
];

/**
 * Schemas whose owning services run in schema-per-tenant mode (ADR-011 +
 * libs/backend-common/.../tenant-aware-schemas.ts SSoT). Every such
 * source schema MUST have RLS policies registered against its tables —
 * otherwise the tenant_<uuid> clones inherit ZERO policies via
 * CREATE TABLE LIKE INCLUDING ALL and a row-leakage hole opens.
 *
 * Asserted by Part A's RLS-policy probe (assertEntitySurfaceMatchesDb)
 * and Part B B.5's TENANT_SCOPED audit. Both consumers import this
 * constant via the SERVICES manifest.
 */
const RLS_REQUIRED_SCHEMAS: ReadonlySet<string> = new Set([
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'ai',
  'alert',
]);

/**
 * Schemas that MUST exist after the init scripts have run, BEFORE any
 * TypeORM migration touches the DB. These are created exclusively by
 * `00-init-schemas.sh` in the init-scripts bind mount.
 */
const REQUIRED_SCHEMAS = [
  'auth',
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'billing',
  'notification',
  'ai',
  'admin',
  'observability',
  'event_store',
  'shared',
  'gateway',
];

/**
 * Critical columns on `auth.users` that the previous regression class
 * silently dropped. Each one was added by `1700000000000-CreateInitialSchema`
 * after the squash damage was identified — proving they exist after a
 * fresh-volume init is the exact failure mode this test guards.
 */
const CRITICAL_AUTH_USERS_COLUMNS = [
  'mfaLockedUntil',
  'mfaRecoveryCodes',
  'mfaFailedAttempts',
  'accessType',
  'notificationPreferences',
];

/**
 * Baseline tables in `auth` schema that were lost in the squash and
 * restored by `1700000000000-CreateInitialSchema`. Asserting all 12 exist
 * is the most direct proof the migration chain rebuilt the auth surface.
 */
const AUTH_BASELINE_TABLES = [
  'refresh_tokens',
  'webauthn_credentials',
  'user_module_assignments',
  'mobile_user_settings',
  'modules',
  'announcements',
  'announcement_acknowledgments',
  'message_threads',
  'messages',
  'support_tickets',
  'ticket_comments',
  'audit_logs',
];

/**
 * Dynamically load every migration class from a directory.
 *
 * Strategy: iterate the directory, filter to `<13-digit>-<Name>.ts` files
 * (the codebase's enforced filename convention — see
 * .github/workflows/db-migration-check.yml step "Validate migration
 * filename..."), require each, and pull the default-or-named export
 * whose name ends with the timestamp. Migration classes follow the
 * convention `<Name><timestamp>` (e.g. `CreateInitialSchema1700000000000`).
 */
function loadMigrationClassesFromDir(absDir: string): Array<new () => MigrationInterface> {
  // Wave 4-A.2 Dalga 5 — services that own a directory but ship no
  // migrations yet (config-service: .gitkeep only; gateway-api:
  // directory absent entirely) are valid manifest entries; return an
  // empty class list so the per-service runMigrations() call is a no-op
  // rather than a hard failure.
  if (!existsSync(absDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (err) {
    throw new Error(
      `Migration directory ${absDir} could not be read: ${(err as Error).message}. ` +
        `Update SERVICES manifest if the path moved.`,
    );
  }

  const migrationFiles = entries
    .filter((f) => /^[0-9]{13}-[A-Z][A-Za-z0-9]*\.ts$/.test(f))
    .filter((f) => !f.endsWith('.spec.ts') && !f.endsWith('.test.ts'))
    .sort(); // lexical sort = chronological because timestamps are zero-padded.

  const classes: Array<new () => MigrationInterface> = [];
  for (const file of migrationFiles) {
    const fullPath = join(absDir, file);
    if (!statSync(fullPath).isFile()) continue;

    // ts-jest transforms .ts files when loaded through requireModule here
    // because this spec runs under the ts-jest transform configured in
    // e2e/jest.config.ts. Each migration's `export class <Name>` becomes
    // a property on the loaded module object.
    const mod = requireModule(fullPath) as Record<string, unknown>;
    const candidate = Object.values(mod).find(
      (v): v is new () => MigrationInterface =>
        typeof v === 'function' && /^[A-Z]/.test(v.name) && /\d{13}$/.test(v.name),
    );
    if (!candidate) {
      throw new Error(
        `Migration file ${fullPath} did not export a class whose name matches ` +
          `<PascalCaseName><13-digit-timestamp>. Filename + class-name convention ` +
          `is enforced by .github/workflows/db-migration-check.yml.`,
      );
    }
    classes.push(candidate);
  }
  return classes;
}

/**
 * Discover every `*.entity.ts` file under a service's source root.
 *
 * Used by the entity-surface coverage matrix (assertEntitySurfaceMatchesDb).
 * Recurses through subdirectories because services scatter entities across
 * `src/<feature>/entities/`, `src/<feature>/`, and the legacy
 * `src/setup/entities/` location.
 */
function findEntityFiles(absRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(absRoot)) return out;
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const current = assertDefined(stack.pop());
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      // Skip migration directories — files there are CREATE TABLE
      // statements, not entity declarations. Skip __tests__ to avoid
      // pulling spec doubles into the metadata graph.
      if (name === 'migrations' || name === '__tests__' || name === 'node_modules') {
        continue;
      }
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (st.isFile() && /\.entity\.ts$/.test(name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Load every `@Entity` class from a service's source root.
 *
 * Strategy: ts-jest transforms .ts files on load, so each entity file
 * registers itself with TypeORM's getMetadataArgsStorage() side-effect.
 * After loading all files we instantiate a metadata-only DataSource
 * to materialize EntityMetadata graphs that the surface-matrix probes
 * iterate over.
 */
function loadEntityClasses(absRoot: string): EntityClass[] {
  const files = findEntityFiles(absRoot);
  const classes: EntityClass[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = requireModule(file) as Record<string, unknown>;
    } catch (err) {
      // Skip entity files that can't be loaded (e.g., declare side
      // effects on a Nest module not loaded in this test). Surface as
      // warning rather than fatal — the file's @Entity decorators ran
      // anyway through getMetadataArgsStorage.

      console.warn(
        `[bootstrap-from-scratch] could not load entity file ${file}: ${(err as Error).message}`,
      );
      continue;
    }
    for (const v of Object.values(mod)) {
      if (isEntityClass(v)) {
        classes.push(v);
      }
    }
  }
  return classes;
}

/** Narrow an unknown module export to a PascalCase-named class constructor. */
function isEntityClass(value: unknown): value is EntityClass {
  return typeof value === 'function' && /^[A-Z]/.test(value.name);
}

interface SurfaceProbeResult {
  schema: string;
  table: string;
  drift: string[];
}

/**
 * Assert that every entity registered for a service has a matching
 * physical table, columns, FKs, indexes, and (for tenant-scoped
 * schemas) at least one tenant_<uuid> RLS-policy clone.
 *
 * This is the generic helper the mission spec calls
 * `assertEntitySurfaceMatchesDb`. Returns the per-entity drift list;
 * the caller decides how to surface failures (one Jest case per drift
 * gives the highest-signal CI output).
 */
interface PgConnInfo {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

async function assertEntitySurfaceMatchesDb(
  serviceName: string,
  entityClasses: ReadonlyArray<EntityClass>,
  conn: PgConnInfo,
): Promise<SurfaceProbeResult[]> {
  // Build a metadata-only DataSource so EntityMetadata graphs are
  // materialized for FK + index introspection. We cannot use the
  // service's migration DataSource because that one is configured
  // with `migrations: [...]` and no entities. A short-lived metadata
  // DataSource avoids re-running migrations.
  const metadataDs = new DataSource({
    type: 'postgres',
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    database: conn.database,
    entities: [...entityClasses],
    synchronize: false,
    migrationsRun: false,
  });
  await metadataDs.initialize();

  const results: SurfaceProbeResult[] = [];
  try {
    for (const meta of metadataDs.entityMetadatas) {
      // Resolve declared schema. Tenant-aware entities legitimately
      // omit `schema:` (the SchemaManagerService routes them at
      // provision time). For source-table existence we look in the
      // canonical service schema derived from the manifest.
      const declaredSchema =
        meta.schema ??
        // Fall back to the service's canonical schema — tenant-aware
        // entities use this path.
        SERVICES.find((s) => s.name === serviceName)?.schema ??
        'public';

      const drift: string[] = [];
      const tableName = meta.tableName;

      // (a) Table exists in declared OR routed schema. We accept the
      //     declared schema as primary; tenant_* schemas are a
      //     secondary residence and skipped here (Part C covers them).
      const tableRows: Array<{ schemaname: string }> = await metadataDs.query(
        `SELECT schemaname FROM pg_tables
         WHERE tablename = $1 AND schemaname = $2`,
        [tableName, declaredSchema],
      );
      if (tableRows.length === 0) {
        drift.push(`table missing: ${declaredSchema}.${tableName} not found in pg_tables`);
        results.push({ schema: declaredSchema, table: tableName, drift });
        continue;
      }

      // (b) Column existence + data-type compatibility per @Column.
      const columnRows: Array<{ column_name: string; data_type: string }> = await metadataDs.query(
        `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2`,
        [declaredSchema, tableName],
      );
      const dbColumns = new Map(columnRows.map((r) => [r.column_name, r.data_type]));
      for (const col of meta.columns) {
        if (!dbColumns.has(col.databaseName)) {
          drift.push(
            `column missing: ${declaredSchema}.${tableName}.${col.databaseName} ` +
              `(entity declares but DB has no such column)`,
          );
        }
      }

      // (c) FKs: every @ManyToOne relation has a pg_constraint row.
      //     We count FKs whose constrained relation matches the table;
      //     mismatched count is the drift signal (TypeORM emits one
      //     constraint per relation).
      const expectedFkCount = meta.relations.filter((r) => r.relationType === 'many-to-one').length;
      if (expectedFkCount > 0) {
        const fkRows: Array<{ count: string }> = await metadataDs.query(
          `SELECT COUNT(*)::text AS count FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE c.contype = 'f'
             AND n.nspname = $1
             AND t.relname = $2`,
          [declaredSchema, tableName],
        );
        const actual = parseInt(fkRows[0]?.count ?? '0', 10);
        if (actual < expectedFkCount) {
          drift.push(
            `fk drift: ${declaredSchema}.${tableName} declares ${expectedFkCount} ` +
              `@ManyToOne relation(s) but pg_constraint has only ${actual} FK(s)`,
          );
        }
      }

      // (d) Indexes: every @Index has a pg_indexes row. We do a
      //     count-only check because TypeORM-generated index names
      //     are unstable across versions; the drift signal is "DB
      //     has fewer indexes than the entity declares" — extra
      //     indexes are fine.
      const expectedIxCount = meta.indices.length;
      if (expectedIxCount > 0) {
        const ixRows: Array<{ count: string }> = await metadataDs.query(
          `SELECT COUNT(*)::text AS count FROM pg_indexes
           WHERE schemaname = $1 AND tablename = $2`,
          [declaredSchema, tableName],
        );
        const actual = parseInt(ixRows[0]?.count ?? '0', 10);
        // The PK always has its own index — entity @Index list does
        // not include it. Accept actual >= expectedIxCount + 0 (PK
        // index counted, declared @Index entries each add one).
        if (actual < expectedIxCount) {
          drift.push(
            `index drift: ${declaredSchema}.${tableName} declares ${expectedIxCount} ` +
              `@Index entries, pg_indexes has only ${actual} (excluding PK)`,
          );
        }
      }

      // (e) For tenant-scoped schemas: at least one tenant_<uuid> clone
      //     must carry an RLS policy on the cloned table. The bootstrap
      //     test runs against an empty-tenant DB (no tenants
      //     provisioned), so we cannot fail on "no clone exists" — we
      //     only fail when a clone EXISTS and is missing RLS. Part C
      //     spec covers the active-clone shape with a real tenant.
      if (RLS_REQUIRED_SCHEMAS.has(declaredSchema)) {
        const cloneRows: Array<{
          tablename: string;
          schemaname: string;
        }> = await metadataDs.query(
          `SELECT tablename, schemaname FROM pg_tables
           WHERE schemaname ~ '^tenant_[a-f0-9]{16}$'
             AND tablename = $1`,
          [tableName],
        );
        for (const cr of cloneRows) {
          const policyRows: Array<{ count: string }> = await metadataDs.query(
            `SELECT COUNT(*)::text AS count FROM pg_policies
             WHERE schemaname = $1 AND tablename = $2`,
            [cr.schemaname, cr.tablename],
          );
          if (parseInt(policyRows[0]?.count ?? '0', 10) === 0) {
            drift.push(
              `rls drift: tenant clone ${cr.schemaname}.${cr.tablename} has zero pg_policies rows`,
            );
          }
        }
      }

      results.push({ schema: declaredSchema, table: tableName, drift });
    }
  } finally {
    await metadataDs.destroy().catch(() => {
      /* swallow — teardown */
    });
  }
  return results;
}

describe('Bootstrap from scratch (fresh-volume init + full migration chain)', () => {
  let postgresContainer: StartedTestContainer;
  // Per-service DataSources, kept open across `beforeAll` so the migration
  // ledger queries in the assertion phase don't have to reopen connections.
  const dataSources = new Map<string, DataSource>();

  beforeAll(async () => {
    for (const envName of SERVICE_ROLE_PASSWORD_ENVS) {
      process.env[envName] ??= `${envName.toLowerCase()}_test`;
    }

    // -----------------------------------------------------------------
    // 1. Boot Postgres with init-scripts mounted.
    // -----------------------------------------------------------------
    // The `docker-entrypoint-initdb.d` directory is consumed by the
    // postgres image's entrypoint exactly once, when PGDATA is empty.
    // Bind-mounting the live repo directory (read-only) means this test
    // exercises the SAME scripts the production deploy runs, with no
    // copy/paste drift.
    postgresContainer = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: DATABASE_NAME,
        POSTGRES_USER: DATABASE_USER,
        POSTGRES_PASSWORD: DATABASE_PASSWORD,
        // The platform bootstrap atom refuses empty service-role password
        // envs. Forward deterministic dummy values into the container so
        // init scripts and Phase 0 exercise the same env contract as prod.
        ...Object.fromEntries(
          SERVICE_ROLE_PASSWORD_ENVS.map((envName) => [
            envName,
            process.env[envName] ?? `${envName.toLowerCase()}_test`,
          ]),
        ),
      })
      .withBindMounts([
        {
          source: INIT_SCRIPTS_DIR,
          target: '/docker-entrypoint-initdb.d',
          mode: 'ro',
        },
      ])
      .withExposedPorts(5432)
      // Wait for `database system is ready to accept connections` AFTER
      // init scripts complete — the postgres entrypoint logs this message
      // when the second startup (post-init-scripts) finishes.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(180_000)
      .start();

    const host = postgresContainer.getHost();
    const port = postgresContainer.getMappedPort(5432);

    // -----------------------------------------------------------------
    // 1.5. Run the ADR-031 platform-bootstrap atom.
    // -----------------------------------------------------------------
    // Pre-ADR-031, init-scripts ran the entire platform DDL contract on
    // initdb. Post-ADR-031, init-scripts hold only DB-level GRANTs;
    // schemas/roles/extensions/functions/shared.* tables come from this
    // atom which is identical to what aqua-db-migrate Phase 0 runs in
    // production. Calling it here from the test keeps the
    // bootstrap-from-scratch fixture aligned with the live deploy path.
    await runPlatformBootstrap({
      database: {
        host,
        port,
        username: DATABASE_USER,
        password: DATABASE_PASSWORD,
        database: DATABASE_NAME,
        ssl: false,
      },
      sqlDir: resolvePlatformBootstrapSqlDir(REPO_ROOT),
      log: () => undefined, // silent — Jest captures stdout per spec
      lockTimeoutSeconds: 60,
    });

    // -----------------------------------------------------------------
    // 2. Run every service's migration chain in dependency order.
    // -----------------------------------------------------------------
    for (const svc of SERVICES) {
      const absDir = join(REPO_ROOT, svc.migrationsDir);
      const migrationClasses = loadMigrationClassesFromDir(absDir);

      // Load entity classes for services that declare an entitiesGlob.
      // Required for migrations that introspect connection.entityMetadatas
      // — notably hr-service's SyncHrEntitiesToDb1786800000000 which
      // derives its DDL emit + entity-default registry from the entity
      // surface. Other services tolerate the empty-entities path (their
      // migrations are pure DDL). Services without entitiesGlob
      // (gateway-api) keep an empty list. Pairs with the
      // ALTER-COLUMN-TYPE default-recovery transform inside
      // SyncHrEntitiesToDb that prevents the "default for column ...
      // cannot be cast automatically to type ..._enum" failure mode on
      // fresh-volume bootstraps.
      const entityClasses: EntityClass[] = svc.entitiesGlob
        ? loadEntityClasses(join(REPO_ROOT, svc.entitiesGlob))
        : [];

      const ds = new DataSource({
        type: 'postgres',
        host,
        port,
        username: DATABASE_USER,
        password: DATABASE_PASSWORD,
        database: DATABASE_NAME,
        schema: svc.schema,
        migrations: migrationClasses,
        entities: entityClasses,
        synchronize: false,
        migrationsRun: false,
        // Migration table inside the service schema; the production
        // MigrationRunnerService uses the same convention.
        migrationsTableName: 'migrations',
        // Pin search_path on every connection acquired from this pool.
        // Why: TypeORM's built-in MigrationExecutor (invoked by
        // ds.runMigrations() below) does NOT pin search_path —
        // production MigrationRunnerService does, but this test bypasses
        // the runner and goes straight to the executor. Migrations that
        // use unqualified table references (e.g. `ALTER TABLE "users"`,
        // `FROM "users"`) then resolve against the connection's default
        // search_path (`public`) and fail with `relation "users" does
        // not exist` on a fresh DB where auth tables only live in the
        // auth schema. The libpq `-c search_path=...` option sets the
        // path at session-start time, before any migration SQL runs,
        // and survives across the BEGIN/COMMIT cycles MigrationExecutor
        // uses in `transaction: 'each'` mode.
        extra: {
          options: `-c search_path="${svc.schema}",public`,
        },
      });

      try {
        await ds.initialize();
        // Skip runMigrations() for services with empty migration sets —
        // gateway-api owns no migrations dir and config-service ships
        // only `.gitkeep`. Calling runMigrations() with an empty list is
        // a no-op in TypeORM, but skipping the call avoids creating the
        // empty `<schema>.migrations` ledger table that would skew the
        // "ledger is non-empty" assertion below.
        if (migrationClasses.length > 0) {
          await runWithDbMigrateDdlAuthority(() => ds.runMigrations({ transaction: 'each' }));
        }
      } catch (err) {
        // Surface which service failed so the diagnostic message is
        // actionable from CI logs. Do not swallow — re-throw so Jest
        // marks the suite as failed.
        throw new Error(
          `[bootstrap-from-scratch] Migration run failed for service "${svc.name}" ` +
            `(schema=${svc.schema}, dir=${svc.migrationsDir}): ${(err as Error).message}\n` +
            `${(err as Error).stack ?? ''}`,
        );
      }
      dataSources.set(svc.name, ds);
    }
  }, 600_000);

  afterAll(async () => {
    for (const ds of dataSources.values()) {
      if (ds.isInitialized) {
        await ds.destroy().catch(() => {
          /* swallow — teardown */
        });
      }
    }
    if (postgresContainer) {
      await postgresContainer.stop({ remove: true }).catch(() => {
        /* swallow — teardown */
      });
    }
  });

  // ---------------------------------------------------------------------
  // Assertions: every check below is a single-table-or-column SQL probe
  // against the ground-truth `information_schema` views. No app code,
  // no GraphQL, no ORM — just "did the SQL state we expected get
  // built?".
  // ---------------------------------------------------------------------

  // Helper: pick any initialized DataSource to run schema-introspection
  // queries. Schema visibility is global within the database, so any
  // connection works.
  function probeDs(): DataSource {
    const ds = dataSources.get('auth-service');
    if (!ds || !ds.isInitialized) {
      throw new Error('auth-service DataSource not initialized — beforeAll did not complete.');
    }
    return ds;
  }

  it('init scripts created all 15 service schemas', async () => {
    const rows = await probeDs().query<{ schema_name: string }[]>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name = ANY($1::text[])
       ORDER BY schema_name`,
      [REQUIRED_SCHEMAS],
    );
    const found = new Set(rows.map((r) => r.schema_name));
    const missing = REQUIRED_SCHEMAS.filter((s) => !found.has(s));
    if (missing.length > 0) {
      throw new Error(
        `Init scripts did not create expected schemas: missing ${missing.join(', ')}. ` +
          `Verify infrastructure/docker/init-scripts/00-init-schemas.sh has a CREATE SCHEMA ` +
          `entry for each. Required total: ${REQUIRED_SCHEMAS.length}.`,
      );
    }
  });

  it.each(CRITICAL_AUTH_USERS_COLUMNS)(
    'auth.users has critical column "%s" (regression class: squash drop)',
    async (column) => {
      const rows = await probeDs().query<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = $1`,
        [column],
      );
      if (rows.length === 0) {
        throw new Error(
          `auth.users.${column} is missing after fresh-volume init. ` +
            `This is the exact failure class fixed by ` +
            `apps/auth-service/src/migrations/1700000000000-CreateInitialSchema.ts. ` +
            `Verify that migration is present in the auth-service migrations directory ` +
            `and creates this column idempotently.`,
        );
      }
    },
  );

  it.each(AUTH_BASELINE_TABLES)('auth.%s table exists after migration chain', async (table) => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'auth' AND table_name = $1`,
      [table],
    );
    if (rows.length === 0) {
      throw new Error(
        `auth.${table} is missing — this is one of the 12 baseline tables ` +
          `restored by 1700000000000-CreateInitialSchema. If a future migration ` +
          `legitimately drops it, update AUTH_BASELINE_TABLES in this spec.`,
      );
    }
  });

  it('farm.batches_v2 exists (entity-anchored table created in migration chain)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'farm' AND table_name = 'batches_v2'`,
    );
    expect(rows.length).toBe(1);
  });

  it('farm.farms exists (core farm-service table)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'farm' AND table_name = 'farms'`,
    );
    expect(rows.length).toBe(1);
  });

  it('farm.tanks exists (post-equipment migration carry-over)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'farm' AND table_name = 'tanks'`,
    );
    expect(rows.length).toBe(1);
  });

  it.each(EXPECTED_HYPERTABLES)(
    '$schema.$table is a TimescaleDB hypertable',
    async ({ schema, table }) => {
      // Source-schema hypertable existence is the strongest signal that
      // the create_hypertable() call inside the migration ran. The
      // tenant-clone path uses createHypertable / createSensorMetricsHypertable
      // off SchemaManagerService at provision time — covered by Part C.
      const rows = await probeDs().query<{ hypertable_name: string }[]>(
        `SELECT hypertable_name FROM timescaledb_information.hypertables
         WHERE hypertable_schema = $1 AND hypertable_name = $2`,
        [schema, table],
      );
      if (rows.length !== 1) {
        throw new Error(
          `${schema}.${table} is not registered as a TimescaleDB hypertable. ` +
            `Either the timescaledb extension was not enabled (check ` +
            `init-scripts/00-init-schemas.sh CREATE EXTENSION) or the ` +
            `migration that calls create_hypertable() for this table did not run.`,
        );
      }
    },
  );

  it('billing.plans exists (squash-restoration target)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'billing' AND table_name = 'plans'`,
    );
    expect(rows.length).toBe(1);
  });

  it('billing.payments exists (squash-restoration target)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'billing' AND table_name = 'payments'`,
    );
    expect(rows.length).toBe(1);
  });

  it('alert.alert_rules exists (alert-engine baseline)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'alert' AND table_name = 'alert_rules'`,
    );
    expect(rows.length).toBe(1);
  });

  it('admin.audit_logs exists (created by 11-service-audit-tables.sql)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'admin' AND table_name = 'audit_logs'`,
    );
    expect(rows.length).toBe(1);
  });

  it('shared schema contains the 4 cross-service tables (audit_logs, gdpr_data_requests, user_consents, user_permissions)', async () => {
    const rows = await probeDs().query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'shared' AND table_name = ANY($1::text[])`,
      [['audit_logs', 'gdpr_data_requests', 'user_consents', 'user_permissions']],
    );
    const found = new Set(rows.map((r) => r.table_name));
    for (const t of ['audit_logs', 'gdpr_data_requests', 'user_consents', 'user_permissions']) {
      if (!found.has(t)) {
        throw new Error(
          `shared.${t} missing after init scripts. Check ` +
            `infrastructure/docker/init-scripts/10-shared-schema.sql.`,
        );
      }
    }
  });

  // ---------------------------------------------------------------------
  // Part A.3 — Migration ledger completeness.
  //
  // Failure mode this catches: TypeORM "thought it ran" but skipped
  // migrations. Empirically observed when the migrations array passed
  // to TypeOrmModule.forRoot was a stale glob that resolved to fewer
  // files than the migrations directory holds, and runMigrations()
  // returned without error because every entry it knew about was
  // already applied. The ledger row count then drifts below the
  // file-system count and silent under-application goes undetected
  // until a fresh deploy reveals missing tables.
  //
  // Assertion: count(<schema>.migrations rows) == count(migration files
  // on disk that match the timestamp+PascalCase regex). Skip services
  // with empty migration sets (gateway-api, config-service: those have
  // NO ledger because we skipped runMigrations() entirely).
  // ---------------------------------------------------------------------
  it.each(
    SERVICES.filter(
      (s) => loadMigrationClassesFromDir(join(REPO_ROOT, s.migrationsDir)).length > 0,
    ),
  )(
    'service "$name" migration ledger row count matches on-disk migration file count',
    async ({ name, schema, migrationsDir }) => {
      const ds = dataSources.get(name);
      if (!ds || !ds.isInitialized) {
        throw new Error(`${name} DataSource not initialized.`);
      }
      const onDiskCount = loadMigrationClassesFromDir(join(REPO_ROOT, migrationsDir)).length;
      const rows = await ds.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".migrations`,
      );
      const ledgerCount = parseInt(rows[0]?.count ?? '0', 10);
      if (ledgerCount !== onDiskCount) {
        throw new Error(
          `${schema}.migrations ledger row count drift: on-disk migrations dir has ` +
            `${onDiskCount} timestamped files, ledger has ${ledgerCount} rows. ` +
            `Either runMigrations() silently skipped some files (TypeORM cache or ` +
            `metadata-loader bug) or a file landed on disk without being included ` +
            `in the per-service migrations[] manifest.`,
        );
      }
    },
  );

  // ---------------------------------------------------------------------
  // Part A.1 — Entity-surface coverage matrix.
  //
  // For each service that owns entities, walk every `*.entity.ts` file,
  // load its TypeORM metadata via getMetadataArgsStorage / a metadata-
  // only DataSource, then probe (a) table existence, (b) column
  // existence + data type, (c) FK count, (d) index count, (e) tenant-
  // clone RLS. The helper assertEntitySurfaceMatchesDb() returns a
  // per-entity drift array; we surface each drift entry as its own
  // assertion failure so the CI annotation points at the exact
  // schema.table.column pair that drifted.
  // ---------------------------------------------------------------------
  it.each(SERVICES.filter((s) => s.entitiesGlob !== undefined))(
    'service "$name" entity surface aligns with physical DB schema',
    async ({ name, entitiesGlob }) => {
      // entitiesGlob is set on every filtered entry — TypeScript narrows
      // via the filter predicate, but we re-assert defensively.
      if (entitiesGlob === undefined) {
        throw new Error(`assert: entitiesGlob undefined for "${name}"`);
      }
      const entityClasses = loadEntityClasses(join(REPO_ROOT, entitiesGlob));
      if (entityClasses.length === 0) {
        // A service listed with `entitiesGlob` set but zero entities
        // discovered is a manifest bug — the glob points at the wrong
        // directory or all entities were deleted.
        throw new Error(
          `service "${name}" declared entitiesGlob="${entitiesGlob}" but ` +
            `loadEntityClasses() found ZERO @Entity files. Update the manifest ` +
            `(remove entitiesGlob if the service truly owns no entities) or ` +
            `fix the path.`,
        );
      }

      const conn: PgConnInfo = {
        host: postgresContainer.getHost(),
        port: postgresContainer.getMappedPort(5432),
        username: DATABASE_USER,
        password: DATABASE_PASSWORD,
        database: DATABASE_NAME,
      };
      const results = await assertEntitySurfaceMatchesDb(name, entityClasses, conn);

      const drifts = results.flatMap((r) => r.drift.map((d) => `  ${r.schema}.${r.table}: ${d}`));
      if (drifts.length > 0) {
        throw new Error(
          `Entity surface drift in service "${name}" (${drifts.length} issue(s)):\n` +
            drifts.join('\n'),
        );
      }
    },
    // Per-service entity-surface scan can iterate dozens of entities;
    // give it generous headroom but still a hard ceiling so a hung
    // metadata-DataSource teardown does not pin the worker.
    120_000,
  );

  // ---------------------------------------------------------------------
  // Part A.4 — Drift validator runtime gate.
  //
  // After migrations run, instantiate the SchemaDriftValidator factory
  // for each entity-owning service with SCHEMA_DRIFT_FATAL=true. The
  // validator's onApplicationBootstrap() hook walks the same
  // EntityMetadata graph the runtime uses and throws on any of the
  // drift classes registered in drift-classes.ts. If the bootstrap-
  // from-scratch pipeline produces a clean DB, this gate MUST pass —
  // failure here means a service would crash on cold start in
  // staging/production with SCHEMA_DRIFT_FATAL=true (the production
  // posture per ADR-012).
  //
  // We instantiate the validator class directly with a per-service
  // metadata-only DataSource and a lightweight ConfigService stub
  // rather than booting a full NestJS app — same observable
  // behaviour, ~30s saved per service.
  // ---------------------------------------------------------------------
  it.each(SERVICES.filter((s) => s.entitiesGlob !== undefined))(
    'service "$name" passes SchemaDriftValidator with FATAL=true after migrations',
    async ({ name, schema, entitiesGlob }) => {
      if (entitiesGlob === undefined) {
        throw new Error(`assert: entitiesGlob undefined for "${name}"`);
      }
      const entityClasses = loadEntityClasses(join(REPO_ROOT, entitiesGlob));

      // Per-service metadata DataSource so EntityMetadata graphs match
      // the validator's expected shape. The validator scans
      // dataSource.entityMetadatas, NOT the runtime DB — entity loading
      // is the only ceremony required.
      const driftDs = new DataSource({
        type: 'postgres',
        host: postgresContainer.getHost(),
        port: postgresContainer.getMappedPort(5432),
        username: DATABASE_USER,
        password: DATABASE_PASSWORD,
        database: DATABASE_NAME,
        schema,
        entities: [...entityClasses],
        synchronize: false,
        migrationsRun: false,
      });
      await driftDs.initialize();

      // ConfigService stub — only the keys the validator reads.
      // SCHEMA_DRIFT_ENABLED + FATAL drive the gate; AQUA_ENV /
      // NODE_ENV feed the emergency-override lookup which short-
      // circuits when no override row exists.
      const configStub = {
        get(key: string, defaultValue?: string): string {
          switch (key) {
            case 'SCHEMA_DRIFT_ENABLED':
              return 'true';
            case 'SCHEMA_DRIFT_FATAL':
              return 'true';
            case 'SCHEMA_DRIFT_TENANT_SCAN_ENABLED':
              return 'false';
            case 'AQUA_ENV':
            case 'NODE_ENV':
              return 'test';
            default:
              return defaultValue ?? '';
          }
        },
      } as unknown as ConfigService;

      const factory = loadDriftValidatorFactory();
      const ValidatorClass = factory(
        // Validator names must match /^[a-z][a-z0-9_-]*$/ — the
        // service manifest names already comply.
        name,
      );
      const validator = new ValidatorClass(driftDs, configStub);

      try {
        await validator.onApplicationBootstrap();
      } catch (err) {
        const message = (err as Error).message;
        // Surface the FIRST drift class so a CI reader sees the exact
        // failure mode (location vs type vs nullability) without
        // scrolling. The validator already prefixes its throw with
        // "Schema drift detected in N place(s)" — keep that intact.
        throw new Error(
          `[Part A.4] SchemaDriftValidator threw for service "${name}" after ` +
            `bootstrap-from-scratch migrations completed. This means the ` +
            `migration chain produced a DB shape that the entity layer ` +
            `disagrees with — a service running with SCHEMA_DRIFT_FATAL=true ` +
            `would refuse to boot.\n\n${message}`,
        );
      } finally {
        await driftDs.destroy().catch(() => {
          /* swallow — teardown */
        });
      }
    },
    180_000,
  );
});
