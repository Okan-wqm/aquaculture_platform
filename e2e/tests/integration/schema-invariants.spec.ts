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

import { TestDatabase } from '../../helpers/db.helper';

const ALLOWED_PUBLIC_TABLES = new Set<string>([
  // TypeORM migration ledger — system table, not application data.
  'migrations',
]);

const SHARED_SCHEMA_TABLES = new Set<string>([
  'audit_logs',
  'gdpr_data_requests',
  'user_consents',
  'user_permissions',
]);

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

  it('shared schema contains exactly the four cross-service tables', async () => {
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
          `The shared schema is reserved for tables written by three or more ` +
          `services. New tables here require a PR review explaining the ` +
          `cross-service contract and an update to SHARED_SCHEMA_TABLES.`,
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
});
