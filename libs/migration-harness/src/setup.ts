/**
 * Jest harness lifecycle helpers — shared-container-per-file model.
 * ============================================================================
 *
 * Canonical pattern from `docs/patterns/jest-testcontainers.md`. Every
 * Postgres-backed spec file in this lib and downstream consumers uses
 * these helpers in its `beforeAll` / `afterAll` hooks.
 *
 * # Usage
 *
 * ```ts
 * import { bootPostgresContainer, shutdownHarness, withEphemeralSchema } from '@platform/migration-harness';
 *
 * describe('my migration', () => {
 *   let ctx: HarnessContext;
 *   beforeAll(async () => { ctx = await bootPostgresContainer(); }, 60_000);
 *   afterAll(async () => { await shutdownHarness(ctx); }, 30_000);
 *
 *   it('converges to entities', async () => {
 *     await withEphemeralSchema(ctx, async (schema, qr) => {
 *       // ... seed drift + run migration + assert
 *     });
 *   });
 * });
 * ```
 *
 * # Image pinning (plan v3 R30)
 *
 * The default image is `timescale/timescaledb-ha:pg16` WITH an exact
 * `@sha256:...` digest — the same digest `docker-compose.droplet.yml`
 * uses for the production aqua-postgres container. Test PG ≡ prod PG
 * — no drift class hidden by image-version difference.
 *
 * To override for a targeted test (e.g. exercising a newer PG feature):
 *
 * ```ts
 * beforeAll(async () => { ctx = await bootPostgresContainer({ image: 'postgres:17-alpine' }); });
 * ```
 *
 * The override accepts any image ID; the harness does not validate.
 * Supply-chain concern is the caller's responsibility when overriding.
 *
 * # Running without Docker (`MIGRATION_HARNESS_PG_URL`)
 *
 * Set `MIGRATION_HARNESS_PG_URL=postgres://user:pass@host:port/maintenance_db`
 * and `bootPostgresContainer()` starts no container: it connects to that
 * server, creates a fresh database for THIS boot, and drops it on
 * `shutdownHarness`. Isolation is the same as a container per boot — one
 * database per `beforeAll`, gone on `afterAll` — so a suite cannot tell the
 * two apart and needs no changes. The role must be allowed to CREATE DATABASE.
 *
 * WHY: the Postgres lane is the only way to see an entity or table the
 * fixture forgot (EntityMetadataNotFoundError surfaces at runtime, inside a
 * handler), and it could not run anywhere Docker was unavailable — so those
 * defects reached CI blind, three times on one spec. `image`,
 * `testOptimisations` and `labels` describe a container and are ignored on
 * an external server; the server's own settings apply.
 */
import { randomBytes } from 'node:crypto';

import type { DataSource, QueryRunner } from 'typeorm';

/**
 * Production aqua-postgres image pin. Kept in sync with
 * `docker-compose.droplet.yml` so harness drift-detection runs against
 * the same server version the droplet does.
 *
 * Rebumping cadence: follow the main compose file. When that pin changes,
 * update this constant in the SAME PR. Until a CI invariant enforces this
 * (tracked as Phase 6 work alongside SCHEMA_REGISTRY codegen), the contract
 * is maintained by reviewer discipline.
 */
export const DEFAULT_POSTGRES_IMAGE =
  'timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7';

/**
 * HarnessContext: everything a test suite needs to reach PG.
 * Owned by the suite's `beforeAll`; consumers should NOT construct
 * this directly — use `bootPostgresContainer()`.
 */
/**
 * The running Postgres a suite was handed. Testcontainers'
 * `StartedPostgreSqlContainer` satisfies this structurally; the external
 * backend implements it over a database created for this boot. `getId()` is
 * a Docker container id in the container case and `external:<host>:<port>/<db>`
 * otherwise — a suite that shells out to Docker with it (db-migrate's restore
 * verification) needs a container and fails by name on an external server.
 */
export interface HarnessBackend {
  getId(): string;
  stop(): Promise<unknown>;
}

export interface HarnessContext {
  readonly container: HarnessBackend;
  readonly dataSource: DataSource;
  readonly connectionOptions: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
    readonly database: string;
  };
}

export interface BootOptions {
  /** Override image (default: pinned TimescaleDB matching prod droplet). */
  readonly image?: string;
  /** Container start timeout (ms). CI pre-pulls the default image before Jest. */
  readonly startTimeoutMs?: number;
  /** PG test-only optimisations (fsync off, etc.). Default true. */
  readonly testOptimisations?: boolean;
  /** Docker labels used to attest a container's test-only role. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Env var naming an external Postgres to use instead of a container. */
export const EXTERNAL_POSTGRES_ENV = 'MIGRATION_HARNESS_PG_URL';

/** Where `MIGRATION_HARNESS_PG_URL` points: a server + the maintenance db to CREATE DATABASE from. */
export interface ExternalPostgresTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly maintenanceDatabase: string;
}

/**
 * Parse `MIGRATION_HARNESS_PG_URL` from `env`. `undefined` when unset or
 * blank (use a container); throws on a value that is set but unusable, because
 * a suite that silently fell back to Docker on a typo would be testing
 * something other than what the operator asked for.
 */
export function resolveExternalPostgres(
  env: NodeJS.ProcessEnv = process.env,
): ExternalPostgresTarget | undefined {
  const raw = env[EXTERNAL_POSTGRES_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${EXTERNAL_POSTGRES_ENV} is not a URL (expected postgres://user:pass@host:port/db)`,
    );
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `${EXTERNAL_POSTGRES_ENV} must use the postgres:// scheme, got ${url.protocol}`,
    );
  }
  if (url.username === '') {
    throw new Error(
      `${EXTERNAL_POSTGRES_ENV} must carry a username (the role that may CREATE DATABASE)`,
    );
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${EXTERNAL_POSTGRES_ENV} has an invalid port: ${url.port}`);
  }
  const maintenanceDatabase = url.pathname.replace(/^\//, '') || 'postgres';

  return {
    host: url.hostname,
    port,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    maintenanceDatabase,
  };
}

async function listRoles(maintenance: {
  query(sql: string): Promise<unknown>;
}): Promise<Set<string>> {
  const rows = await maintenance.query('SELECT rolname FROM pg_roles');
  const names = new Set<string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (typeof row === 'object' && row !== null && 'rolname' in row) {
        const { rolname } = row as { rolname: unknown };
        if (typeof rolname === 'string') names.add(rolname);
      }
    }
  }
  return names;
}

/**
 * The external-server boot: one fresh database per call, dropped on stop().
 * Mirrors the container path's shape exactly so callers see no difference.
 */
async function bootExternalPostgres(target: ExternalPostgresTarget): Promise<HarnessContext> {
  const { DataSource } = await import('typeorm');
  const database = `harness_${randomBytes(6).toString('hex')}`;

  const maintenance = new DataSource({
    type: 'postgres',
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    database: target.maintenanceDatabase,
    entities: [],
    synchronize: false,
    logging: false,
    name: `migration-harness-maintenance-${randomBytes(6).toString('hex')}`,
  });
  await maintenance.initialize();
  // Databases are per boot, but roles are cluster-global: a suite that
  // CREATE ROLEs (farm-service's grant tests do) would collide with the next
  // boot on the same server, where a fresh container never could. Snapshot
  // the roles now and drop the ones this boot added on stop(), so the
  // external server offers the same isolation a container does.
  let rolesBefore: ReadonlySet<string>;
  try {
    await maintenance.query(`CREATE DATABASE "${database}"`);
    rolesBefore = await listRoles(maintenance);
  } catch (error) {
    await maintenance.destroy();
    throw error;
  }

  const connectionOptions = {
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    database,
  };

  const dataSource = new DataSource({
    type: 'postgres',
    ...connectionOptions,
    entities: [],
    synchronize: false,
    logging: false,
    name: `migration-harness-${randomBytes(6).toString('hex')}`,
  });
  await dataSource.initialize();

  const container: HarnessBackend = {
    getId: () => `external:${target.host}:${target.port}/${database}`,
    stop: async () => {
      try {
        if (dataSource.isInitialized) await dataSource.destroy();
      } finally {
        try {
          // FORCE: a suite's own DataSource may still hold a session; the
          // database is this boot's and nothing else may keep it alive.
          await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
          for (const role of await listRoles(maintenance)) {
            if (!rolesBefore.has(role)) {
              await maintenance.query(`DROP ROLE "${role}"`);
            }
          }
        } finally {
          await maintenance.destroy();
        }
      }
    },
  };

  return { container, dataSource, connectionOptions };
}

/**
 * Boot a Postgres testcontainer + initialise an isolated TypeORM
 * DataSource against it. Idempotent per container name — repeat calls
 * create a new container, do not share.
 *
 * Explicit Jest timeout recommended: `beforeAll(async () => { ... }, 60_000)`.
 * Fresh CI runners must pull the canonical image before invoking Jest; this
 * function's timeout is for container readiness and DataSource boot, not
 * dependency acquisition.
 *
 * NOTE: this function dynamically imports `@testcontainers/postgresql`
 * + `typeorm` so the mere act of importing the harness barrel doesn't
 * trigger Docker — only `bootPostgresContainer()` does.
 */
export async function bootPostgresContainer(opts: BootOptions = {}): Promise<HarnessContext> {
  const external = resolveExternalPostgres();
  if (external !== undefined) {
    return bootExternalPostgres(external);
  }

  const image = opts.image ?? DEFAULT_POSTGRES_IMAGE;
  const testOpt = opts.testOptimisations ?? true;

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { DataSource } = await import('typeorm');

  let builder = new PostgreSqlContainer(image)
    .withDatabase('harness')
    .withUsername('harness')
    .withPassword('harness')
    .withStartupTimeout(opts.startTimeoutMs ?? 60_000);

  if (opts.labels) {
    builder = builder.withLabels({ ...opts.labels });
  }

  if (testOpt) {
    // Test-only durability trade-offs — safe because test data is
    // thrown away and we care about migration semantics, not WAL fsync.
    builder = builder.withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
  }

  const container = await builder.start();

  const connectionOptions = {
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  };

  const dataSource = new DataSource({
    type: 'postgres',
    ...connectionOptions,
    entities: [],
    synchronize: false,
    logging: false,
    // Unique name per boot — avoids TypeORM's duplicate-DataSource
    // throw when a single Jest process runs many suites.
    name: `migration-harness-${randomBytes(6).toString('hex')}`,
  });
  await dataSource.initialize();

  return { container, dataSource, connectionOptions };
}

/**
 * Shut a harness down cleanly. Always call from `afterAll` — even when
 * tests fail — or the container leaks for the Jest session lifetime.
 *
 * Accepts `undefined` so `afterAll(() => shutdownHarness(ctx))` works
 * when `beforeAll` failed and ctx is still undefined.
 */
export async function shutdownHarness(ctx: HarnessContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    if (ctx.dataSource.isInitialized) {
      await ctx.dataSource.destroy();
    }
  } catch {
    // Best-effort: destroy errors must not mask test results.
  }
  try {
    await ctx.container.stop();
  } catch {
    // Best-effort shutdown. Testcontainers Ryuk reaper handles any
    // remaining state when the Jest process exits.
  }
}

/**
 * Per-test schema isolation. Creates `test_<uuid16>`, pins search_path,
 * invokes `fn`, then ALWAYS drops the schema — even on test failure.
 *
 * Call from within an `it(...)` block after `bootPostgresContainer`
 * populated ctx in `beforeAll`. Parallel `it`s within the same file
 * get different schema names and don't collide.
 */
export async function withEphemeralSchema<T>(
  ctx: HarnessContext,
  fn: (schema: string, qr: QueryRunner) => Promise<T>,
): Promise<T> {
  const schema = `test_${randomBytes(8).toString('hex')}`;
  const qr = ctx.dataSource.createQueryRunner();
  try {
    await qr.query(`CREATE SCHEMA "${schema}"`);
    // Pin search_path via parameterised set_config per v3 R1 pattern.
    // is_local=false (session-scoped) because the QueryRunner here is
    // in auto-commit mode — `true` (transaction-local) would be a no-op
    // outside a BEGIN…COMMIT block. Production orchestrator code runs
    // inside a per-migration transaction and uses `true`; see
    // docs/patterns/sql-identifier-safety.md §"set_config vs SET LOCAL
    // semantic equivalence" for the gotcha this avoids.
    await qr.query(`SELECT set_config($1, $2, false)`, ['search_path', `${schema},public`]);
    return await fn(schema, qr);
  } finally {
    try {
      await qr.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Best-effort — never mask the original test failure with a
      // teardown error.
    }
    await qr.release();
  }
}
