/**
 * Integration test — proves the harness lifecycle primitives work end-to-end
 * against a real PG testcontainer. This is the first "reality check" that
 * Phase 1 Step 3's setup helpers actually do what their JSDoc claims.
 *
 * Runs ONE container per suite file (plan v3 R9 pattern). Each `it` gets
 * an ephemeral schema via `withHarnessSchema` (which wraps withEphemeralSchema
 * and asserts the harness context booted first).
 */
import {
  bootPostgresContainer,
  shutdownHarness,
  type HarnessContext,
  withEphemeralDatabase,
} from '../index';

import {
  expectDefined,
  expectHarnessContext,
  queryRequiredRow,
  queryRows,
  withHarnessSchema,
} from './test-helpers';

describe('migration-harness setup — integration', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000); // cold image pull budget

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('bootPostgresContainer returns a usable DataSource', async () => {
    const harness = expectHarnessContext(ctx);
    expect(harness.dataSource.isInitialized).toBe(true);
    expect(harness.container).toBeDefined();

    const qr = harness.dataSource.createQueryRunner();
    try {
      const row = await queryRequiredRow<{ db: string }>(qr, 'SELECT current_database() AS db');
      expect(row.db).toBe('harness');
    } finally {
      await qr.release();
    }
  });

  it('withEphemeralSchema creates, pins search_path, and drops cleanly', async () => {
    const harness = expectHarnessContext(ctx);
    const schemaSeen = await withHarnessSchema(harness, async (schema, qr) => {
      // The schema was just created — verify by pg_namespace query.
      const exists = await queryRows<{ present: number }>(
        qr,
        `SELECT 1 AS present FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      expect(exists).toHaveLength(1);

      // search_path is pinned to our schema.
      const searchPath = await queryRequiredRow<{ search_path: string }>(qr, `SHOW search_path`);
      expect(searchPath.search_path).toContain(schema);

      // We can create + query a table within the ephemeral schema.
      await qr.query(`CREATE TABLE thing (id int PRIMARY KEY)`);
      await qr.query(`INSERT INTO thing VALUES (1), (2), (3)`);
      const count = await queryRequiredRow<{ n: number }>(
        qr,
        `SELECT count(*)::int AS n FROM thing`,
      );
      expect(count.n).toBe(3);

      return schema;
    });

    // After the block, the schema is DROPped — a fresh QueryRunner
    // can't find it.
    const freshQr = harness.dataSource.createQueryRunner();
    try {
      const exists = await queryRows<{ present: number }>(
        freshQr,
        `SELECT 1 AS present FROM pg_namespace WHERE nspname = $1`,
        [schemaSeen],
      );
      expect(exists).toHaveLength(0);
    } finally {
      await freshQr.release();
    }
  });

  it('parallel withEphemeralSchema invocations get distinct schemas', async () => {
    const harness = expectHarnessContext(ctx);
    const schemas = await Promise.all([
      withHarnessSchema(harness, (s) => Promise.resolve(s)),
      withHarnessSchema(harness, (s) => Promise.resolve(s)),
      withHarnessSchema(harness, (s) => Promise.resolve(s)),
    ]);
    const unique = new Set(schemas);
    expect(unique.size).toBe(3);
    // All follow the convention test_<16 hex>
    for (const s of schemas) {
      expect(s).toMatch(/^test_[0-9a-f]{16}$/);
    }
  });

  it('isolates fixed schemas in a disposable database and restores the cluster', async () => {
    const harness = expectHarnessContext(ctx);
    let firstDatabase: string | undefined;
    await withEphemeralDatabase(harness, async (database, isolated) => {
      firstDatabase = database;
      const qr = isolated.dataSource.createQueryRunner();
      try {
        await qr.query(`CREATE SCHEMA farm; CREATE TABLE farm.marker (id integer PRIMARY KEY)`);
      } finally {
        await qr.release();
      }
    });

    await withEphemeralDatabase(harness, async (_database, isolated) => {
      const qr = isolated.dataSource.createQueryRunner();
      try {
        const fixedState = await queryRequiredRow<{ farm_schema: string | null }>(
          qr,
          `SELECT to_regnamespace('farm')::text AS farm_schema`,
        );
        expect(fixedState.farm_schema).toBeNull();
      } finally {
        await qr.release();
      }
    });

    const database = expectDefined(firstDatabase, 'ephemeral database name');
    const qr = harness.dataSource.createQueryRunner();
    try {
      const rows = await queryRows<{ present: number }>(
        qr,
        `SELECT 1 AS present FROM pg_database WHERE datname = $1`,
        [database],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await qr.release();
    }
  });

  it('removes an ephemeral database after the callback fails', async () => {
    const harness = expectHarnessContext(ctx);
    let failedDatabase: string | undefined;
    await expect(
      withEphemeralDatabase(harness, (database) => {
        failedDatabase = database;
        throw new Error('simulated database-scoped failure');
      }),
    ).rejects.toThrow('simulated database-scoped failure');

    const database = expectDefined(failedDatabase, 'failed ephemeral database name');
    const qr = harness.dataSource.createQueryRunner();
    try {
      const rows = await queryRows<{ present: number }>(
        qr,
        `SELECT 1 AS present FROM pg_database WHERE datname = $1`,
        [database],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await qr.release();
    }
  });

  it('withEphemeralSchema drops schema even on thrown error (cleanup invariant)', async () => {
    const harness = expectHarnessContext(ctx);
    let s: string | undefined;
    try {
      await withHarnessSchema(harness, (schema) => {
        s = schema;
        throw new Error('simulated test failure');
      });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toHaveProperty('message', 'simulated test failure');
    }
    const schemaSeen = expectDefined(s, 'schema seen before failure');

    const freshQr = harness.dataSource.createQueryRunner();
    try {
      const exists = await queryRows<{ present: number }>(
        freshQr,
        `SELECT 1 AS present FROM pg_namespace WHERE nspname = $1`,
        [schemaSeen],
      );
      expect(exists).toHaveLength(0); // schema was dropped despite thrown error
    } finally {
      await freshQr.release();
    }
  });

  it('shutdownHarness tolerates undefined context (beforeAll failure path)', async () => {
    await expect(shutdownHarness(undefined)).resolves.toBeUndefined();
  });
});
