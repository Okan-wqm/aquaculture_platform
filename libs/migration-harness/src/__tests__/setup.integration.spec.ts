/**
 * Integration test — proves the harness lifecycle primitives work end-to-end
 * against a real PG testcontainer. This is the first "reality check" that
 * Phase 1 Step 3's setup helpers actually do what their JSDoc claims.
 *
 * Runs ONE container per suite file (plan v3 R9 pattern). Each `it` gets
 * an ephemeral schema via `withEphemeralSchema`.
 */
import {
  bootPostgresContainer,
  shutdownHarness,
  withEphemeralSchema,
  type HarnessContext,
} from '../index';

describe('migration-harness setup — integration', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000); // cold image pull budget

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('bootPostgresContainer returns a usable DataSource', async () => {
    expect(ctx).toBeDefined();
    expect(ctx!.dataSource.isInitialized).toBe(true);
    expect(ctx!.container).toBeDefined();

    const qr = ctx!.dataSource.createQueryRunner();
    try {
      const rows = await qr.query('SELECT current_database() AS db');
      expect(rows[0].db).toBe('harness');
    } finally {
      await qr.release();
    }
  });

  it('withEphemeralSchema creates, pins search_path, and drops cleanly', async () => {
    const schemaSeen = await withEphemeralSchema(
      ctx!,
      async (schema, qr) => {
        // The schema was just created — verify by pg_namespace query.
        const exists = await qr.query(
          `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
          [schema],
        );
        expect(exists).toHaveLength(1);

        // search_path is pinned to our schema.
        const sp = await qr.query(`SHOW search_path`);
        expect(sp[0].search_path).toContain(schema);

        // We can create + query a table within the ephemeral schema.
        await qr.query(`CREATE TABLE thing (id int PRIMARY KEY)`);
        await qr.query(`INSERT INTO thing VALUES (1), (2), (3)`);
        const count = await qr.query(`SELECT count(*)::int AS n FROM thing`);
        expect(count[0].n).toBe(3);

        return schema;
      },
    );

    // After the block, the schema is DROPped — a fresh QueryRunner
    // can't find it.
    const freshQr = ctx!.dataSource.createQueryRunner();
    try {
      const exists = await freshQr.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
        [schemaSeen],
      );
      expect(exists).toHaveLength(0);
    } finally {
      await freshQr.release();
    }
  });

  it('parallel withEphemeralSchema invocations get distinct schemas', async () => {
    const schemas = await Promise.all([
      withEphemeralSchema(ctx!, async (s) => s),
      withEphemeralSchema(ctx!, async (s) => s),
      withEphemeralSchema(ctx!, async (s) => s),
    ]);
    const unique = new Set(schemas);
    expect(unique.size).toBe(3);
    // All follow the convention test_<16 hex>
    for (const s of schemas) {
      expect(s).toMatch(/^test_[0-9a-f]{16}$/);
    }
  });

  it('withEphemeralSchema drops schema even on thrown error (cleanup invariant)', async () => {
    const schemaSeen = await (async () => {
      let s: string | undefined;
      try {
        await withEphemeralSchema(ctx!, async (schema) => {
          s = schema;
          throw new Error('simulated test failure');
        });
      } catch (err) {
        expect((err as Error).message).toBe('simulated test failure');
      }
      return s!;
    })();

    const freshQr = ctx!.dataSource.createQueryRunner();
    try {
      const exists = await freshQr.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
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
