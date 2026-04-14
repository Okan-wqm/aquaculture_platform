import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * MovePublicTablesToFarm1786000000000
 * ============================================================================
 *
 * Moves four farm-owned tables from `public` to the `farm` schema:
 *
 *   - public.weather_observations → farm.weather_observations
 *   - public.marine_observations  → farm.marine_observations
 *   - public.weather_settings     → farm.weather_settings
 *   - public.feeder_calibrations  → farm.feeder_calibrations
 *
 * Phase 6/7 of docs/plans/2026-04-14 public-schema teardown. These tables
 * are farm-domain data that ended up in `public` because their `@Entity`
 * decorators omitted the `schema:` option. MODULE_SCHEMAS[farm].tables
 * already declares them as farm-owned (schema-manager.service.ts:208,
 * 218, 280-282), so `SourceSchemaBootstrapService`'s strict-ownership
 * enforcement would have dropped them on next boot once strictOwnership
 * was enabled for the farm schema — except they don't live there yet.
 * This migration makes the physical location match the declared ownership.
 *
 * # Why ALTER TABLE ... SET SCHEMA (not CREATE + INSERT + DROP)
 *
 * `SET SCHEMA` is a PostgreSQL catalog-only operation — sub-millisecond
 * ACCESS EXCLUSIVE on the moving table, preserves rows, FKs, indexes,
 * RLS policies, CHECK constraints, and DEFAULT values in place on disk.
 * Rewriting via CREATE + INSERT would blow up the WAL with a full table
 * copy and would strip RLS policies (they're catalog-bound and do not
 * propagate through INSERT SELECT). For the weather_observations table
 * especially — continuously growing time-series data — the copy approach
 * is unacceptable.
 *
 * # Sequence handling
 *
 * None of these four tables use SERIAL / GENERATED AS IDENTITY with
 * detached sequences. `weather_observations` uses a composite PK on
 * (tenant_id, station_id, observed_at); the other three use UUID PKs
 * generated via gen_random_uuid() defaults. No sequence migration is
 * required.
 *
 * # RLS policies
 *
 * Policies installed by farm-service's EnableRowLevelSecurity migration
 * (1781000000000-RefreshTenantRlsPredicate.ts) discovered tables in the
 * `farm` schema via `applyTenantRlsToSchema(qr, { schemaOverride: 'farm' })`.
 * Tables currently in `public` got RLS from the shared_public_owner fix
 * (ef8e1042 + follow-ups). After SET SCHEMA moves them to farm:
 *   - Existing policies on the table are preserved (they travel with the
 *     catalog entry).
 *   - The per-tenant replication path (`TenantRlsSyncService`) picks up
 *     the farm-schema location on next boot and ensures every tenant_<uuid>
 *     schema has matching policies.
 *
 * # Strict ownership contract
 *
 * MODULE_SCHEMAS[farm].strictOwnership = true — SourceSchemaBootstrapService
 * drops any orphan table in the farm schema on every boot. The tables
 * being moved ARE declared in MODULE_SCHEMAS[farm].tables, so they're
 * not orphans. If this migration is rolled back, the tables return to
 * public; farm-service's next boot WILL NOT re-create them in farm
 * (they're not in the orphan-drop set because they're not in farm
 * schema after rollback). The strict contract holds in both directions.
 *
 * # Idempotency
 *
 * Each move uses a `DO $$` block that checks both source (public) and
 * target (farm) state before moving. Safe to re-run after partial
 * failures or on environments that applied the move manually.
 */
export class MovePublicTablesToFarm1786000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'MovePublicTablesToFarm1786000000000',
  );
  name = 'MovePublicTablesToFarm1786000000000';

  private readonly tables = [
    'weather_observations',
    'marine_observations',
    'weather_settings',
    'feeder_calibrations',
  ];

  public async up(qr: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'farm' AND tablename = '${table}'
          ) THEN
            ALTER TABLE public.${table} SET SCHEMA farm;
            ALTER TABLE farm.${table} OWNER TO farm_service;
            ALTER TABLE farm.${table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE farm.${table} FORCE ROW LEVEL SECURITY;
          END IF;
        END $$;
      `);
      this.logger.log(`Ensured farm.${table} (moved from public if needed)`);
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Reverse order not strictly required (no FK between these four) but
    // kept symmetric for readability.
    for (const table of [...this.tables].reverse()) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'farm' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) THEN
            ALTER TABLE farm.${table} SET SCHEMA public;
            ALTER TABLE public.${table} OWNER TO shared_public_owner;
          END IF;
        END $$;
      `);
      this.logger.log(`Reverted farm.${table} back to public`);
    }
  }
}
