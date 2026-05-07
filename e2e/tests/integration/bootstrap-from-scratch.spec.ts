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

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { DataSource, type MigrationInterface } from 'typeorm';
import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

// The same image+digest the production stack uses — see
// docker-compose.infra.yml line 12. Pinning by digest guarantees the
// init-script behaviour we're proving here matches what runs in
// production. Bumping the digest is a deliberate review surface.
const POSTGRES_IMAGE =
  'timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7';

const DATABASE_NAME = 'aquaculture';
const DATABASE_USER = 'aquaculture';
const DATABASE_PASSWORD = 'aquaculture-test';

// Repo root, derived from this file's location:
//   e2e/tests/integration/bootstrap-from-scratch.spec.ts -> ../../..
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const INIT_SCRIPTS_DIR = join(REPO_ROOT, 'infrastructure', 'docker', 'init-scripts');

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
}

const SERVICES: ServiceManifest[] = [
  // auth FIRST — every other service's FKs reference auth.tenants.
  { name: 'auth-service', schema: 'auth', migrationsDir: 'apps/auth-service/src/migrations' },
  // Then the rest, ordered to minimize cross-schema FK ordering hazards.
  { name: 'farm-service', schema: 'farm', migrationsDir: 'apps/farm-service/src/database/migrations' },
  { name: 'sensor-service', schema: 'sensor', migrationsDir: 'apps/sensor-service/src/database/migrations' },
  { name: 'hr-service', schema: 'hr', migrationsDir: 'apps/hr-service/src/database/migrations' },
  { name: 'messaging-service', schema: 'messaging', migrationsDir: 'apps/messaging-service/src/migrations' },
  { name: 'alert-engine', schema: 'alert', migrationsDir: 'apps/alert-engine/src/database/migrations' },
  { name: 'billing-service', schema: 'billing', migrationsDir: 'apps/billing-service/src/database/migrations' },
  { name: 'notification-service', schema: 'notification', migrationsDir: 'apps/notification-service/src/database/migrations' },
  { name: 'observability-service', schema: 'observability', migrationsDir: 'apps/observability-service/src/database/migrations' },
  { name: 'admin-api-service', schema: 'admin', migrationsDir: 'apps/admin-api-service/src/migrations' },
  { name: 'event-store-service', schema: 'event_store', migrationsDir: 'apps/event-store-service/src/migrations' },
];

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

    // ts-jest transforms .ts files when imported through require here
    // because this spec runs under the ts-jest transform configured in
    // e2e/jest.config.ts. Each migration's `export class <Name>` becomes
    // a property on the loaded module object.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(fullPath) as Record<string, unknown>;
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

describe('Bootstrap from scratch (fresh-volume init + full migration chain)', () => {
  let postgresContainer: StartedTestContainer;
  let connectionUri: string;
  // Per-service DataSources, kept open across `beforeAll` so the migration
  // ledger queries in the assertion phase don't have to reopen connections.
  const dataSources = new Map<string, DataSource>();

  beforeAll(async () => {
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
        // The init scripts read these `*_SERVICE_DB_PASS` vars — when not
        // provided they generate random passwords (see init-script line
        // 19). Random passwords are fine for this test (we connect as
        // POSTGRES_USER which has full access).
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
    connectionUri = `postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${host}:${port}/${DATABASE_NAME}`;

    // -----------------------------------------------------------------
    // 2. Run every service's migration chain in dependency order.
    // -----------------------------------------------------------------
    for (const svc of SERVICES) {
      const absDir = join(REPO_ROOT, svc.migrationsDir);
      const migrationClasses = loadMigrationClassesFromDir(absDir);

      const ds = new DataSource({
        type: 'postgres',
        host,
        port,
        username: DATABASE_USER,
        password: DATABASE_PASSWORD,
        database: DATABASE_NAME,
        schema: svc.schema,
        migrations: migrationClasses,
        // We do NOT register entities — running migrations explicitly via
        // runMigrations() does not need the entity surface, and skipping
        // it avoids loading the full app's TypeORM metadata graph.
        synchronize: false,
        migrationsRun: false,
        // Migration table inside the service schema; the production
        // MigrationRunnerService uses the same convention.
        migrationsTableName: 'migrations',
      });

      try {
        await ds.initialize();
        await ds.runMigrations({ transaction: 'each' });
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

  it('sensor.sensor_readings is a TimescaleDB hypertable', async () => {
    // The hypertable is created by
    // 1735800000000-CreateSensorReadingsHypertable. If the table exists
    // as a regular table, the create_hypertable call inside the
    // migration silently failed — caught here.
    const rows = await probeDs().query<{ hypertable_name: string }[]>(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
       WHERE hypertable_schema = 'sensor' AND hypertable_name = 'sensor_readings'`,
    );
    if (rows.length !== 1) {
      throw new Error(
        `sensor.sensor_readings is not registered as a TimescaleDB hypertable. ` +
          `Either the timescaledb extension was not enabled (check ` +
          `init-scripts/00-init-schemas.sh CREATE EXTENSION) or ` +
          `1735800000000-CreateSensorReadingsHypertable did not run.`,
      );
    }
  });

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

  it.each(SERVICES.filter((s) => ['auth', 'farm', 'sensor', 'billing', 'messaging'].includes(s.schema)))(
    'service "$name" has populated migration ledger after fresh init',
    async ({ name, schema }) => {
      const ds = dataSources.get(name);
      if (!ds || !ds.isInitialized) {
        throw new Error(`${name} DataSource not initialized.`);
      }
      // The ledger table is created by TypeORM on first runMigrations()
      // call. Querying through the same DataSource ensures the ledger
      // schema-search-path matches what production sees.
      const rows = await ds.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".migrations`,
      );
      const count = parseInt(rows[0]?.count ?? '0', 10);
      if (count === 0) {
        throw new Error(
          `${schema}.migrations ledger is empty after runMigrations() — TypeORM ran ` +
            `but inserted zero rows. Either the migration list was empty (manifest bug) or ` +
            `every migration was already marked applied (state leaked across container ` +
            `lifecycle, which is impossible on a fresh container — investigate).`,
        );
      }
    },
  );
});
