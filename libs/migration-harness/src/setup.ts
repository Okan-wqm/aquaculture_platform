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
 */
import { randomBytes } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
export interface HarnessContext {
  readonly container: StartedPostgreSqlContainer;
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
