/**
 * defineMigrationTest — declarative per-migration test wrapper.
 * ============================================================================
 *
 * Takes a migration class + prior-state seed + optional assertions, generates
 * a `describe` block that:
 *
 *   1. Boots ONE testcontainer in `beforeAll`
 *   2. For the `it('applies cleanly to prior state')` case:
 *      - CREATE SCHEMA `<opts.schema>` (the exact name the migration expects)
 *      - Pin search_path
 *      - Run `priorState` seed (raw SQL string OR callback)
 *      - Instantiate the migration class (new opts.migration())
 *      - Invoke migration.up(qr)
 *      - Run `assertions` callback (caller-supplied post-migration checks)
 *   3. DROP SCHEMA CASCADE in the finally block (ALWAYS — even on test
 *      failure)
 *   4. Shuts the container down in `afterAll`
 *
 * # Usage
 *
 * ```ts
 * import { defineMigrationTest } from '@platform/migration-harness';
 * import { HealHrEnumTypeDrift1786900000000 } from '...';
 *
 * defineMigrationTest({
 *   migration: HealHrEnumTypeDrift1786900000000,
 *   schema: 'hr',
 *   priorState: `CREATE TABLE hr.payrolls (id uuid PRIMARY KEY, status text)`,
 *   assertions: async ({ qr }) => {
 *     const cols = await qr.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='hr' AND column_name='status'`);
 *     expect(cols[0].data_type).toBe('USER-DEFINED');
 *   },
 * });
 * ```
 *
 * # Why a declarative wrapper
 *
 * Every migration spec would otherwise repeat the same beforeAll /
 * afterAll / try-finally boilerplate. The wrapper amortises that into
 * one import + one call, standardising the test shape across the
 * repo so reviewers scan a spec in seconds.
 *
 * # What this wrapper does NOT do
 *
 * - Drift assertion (Class A-G per plan v3 R11). That ships with
 *   `expectNoDriftAgainst` + `toHaveNoDrift` matcher in Phase 1 Step 5.
 *   Until then, caller supplies drift-equivalent checks via the
 *   `assertions` callback (ad-hoc information_schema queries).
 * - Tenant fan-out. Per plan v3 R22 the harness caps at tenantCount=3
 *   and the test doesn't iterate across tenants. Fan-out semantics
 *   are orchestrator concern (Phase 6), not migration-harness.
 * - down() rollback testing. Most heal migrations have no-op down();
 *   when Phase 3.5 adds expand/contract decorators with real rollback
 *   semantics, extend this wrapper with a `testDown: true` opt-in.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  type HarnessContext,
  bootPostgresContainer,
  shutdownHarness,
} from './setup';

/**
 * Minimal TypeScript shape for a migration CLASS (not instance). TypeORM
 * exposes MigrationInterface as a structural interface; at runtime a
 * migration is always a class with `up(qr)` / `down(qr)` methods, so
 * `{ new (): MigrationInterface }` is the correct type for a constructable
 * reference.
 */
export type MigrationClass = { new (): MigrationInterface; name: string };

/**
 * Callback that seeds the DB state BEFORE the migration runs. Receives
 * a live QueryRunner with search_path already pinned to `opts.schema`.
 */
export type PriorStateCallback = (ctx: {
  qr: QueryRunner;
  schema: string;
}) => Promise<void>;

/**
 * Callback for post-migration assertions. Same context shape as
 * PriorStateCallback. If not supplied, the test only asserts that
 * migration.up() didn't throw — caller must add explicit assertions
 * to exercise the migration's post-condition contract.
 */
export type AssertionsCallback = (ctx: {
  qr: QueryRunner;
  schema: string;
}) => Promise<void>;

export interface DefineMigrationTestOpts {
  /** The migration CLASS (not instance). Harness does `new migration()`. */
  migration: MigrationClass;
  /**
   * Exact schema name the migration expects (e.g. 'hr'). Harness creates
   * it fresh for this test, pins search_path, DROPs CASCADE afterward.
   */
  schema: string;
  /**
   * Prior DB state. Either raw SQL string (executed verbatim) or an
   * async callback receiving a live QueryRunner. If omitted, the
   * migration runs against an empty schema (just CREATE SCHEMA).
   */
  priorState?: string | PriorStateCallback;
  /** Post-migration assertions. Omitted = no-throw is the only check. */
  assertions?: AssertionsCallback;
  /**
   * Custom boot options (passed to bootPostgresContainer). Default is
   * the production-pinned TimescaleDB image + test-only optimisations.
   */
  bootOptions?: Parameters<typeof bootPostgresContainer>[0];
}

/**
 * Declarative test wrapper. Produces a describe/beforeAll/it/afterAll
 * structure as a side effect; returns void.
 */
export function defineMigrationTest(opts: DefineMigrationTestOpts): void {
  describe(`migration ${opts.migration.name}`, () => {
    let ctx: HarnessContext | undefined;

    beforeAll(async () => {
      ctx = await bootPostgresContainer(opts.bootOptions);
    }, 90_000);

    afterAll(async () => {
      await shutdownHarness(ctx);
    }, 30_000);

    it('applies cleanly to prior state', async () => {
      if (!ctx) throw new Error('harness ctx not initialized');
      const qr = ctx.dataSource.createQueryRunner();
      try {
        // The migration expects a schema with the exact name — not the
        // ephemeral `test_<uuid>` pattern. Create + pin + run + drop.
        await qr.query(`CREATE SCHEMA "${opts.schema}"`);
        await qr.query(`SELECT set_config($1, $2, false)`, [
          'search_path',
          `${opts.schema},public`,
        ]);

        // Seed prior state.
        if (opts.priorState) {
          if (typeof opts.priorState === 'string') {
            await qr.query(opts.priorState);
          } else {
            await opts.priorState({ qr, schema: opts.schema });
          }
        }

        // Instantiate the migration CLASS and run up().
        const instance = new opts.migration();
        await instance.up(qr);

        // Post-migration assertions.
        if (opts.assertions) {
          await opts.assertions({ qr, schema: opts.schema });
        }
      } finally {
        // Always clean up — even on failure. Don't mask the test's
        // original failure with a teardown error.
        try {
          await qr.query(`DROP SCHEMA IF EXISTS "${opts.schema}" CASCADE`);
        } catch {
          // best-effort
        }
        await qr.release();
      }
    }, 60_000);
  });
}
