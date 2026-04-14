import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * MovePublicTablesToSensor1786000100000
 * ============================================================================
 *
 * Moves two sensor-owned tables from `public` to the `sensor` schema:
 *
 *   - public.channel_detection_log   → sensor.channel_detection_log
 *   - public.sensor_type_definitions → sensor.sensor_type_definitions
 *
 * Phase 6/7 of docs/plans/2026-04-14 public-schema teardown. Both tables
 * are declared in MODULE_SCHEMAS[sensor] (schema-manager.service.ts:83,
 * 117-119) — channel_detection_log under `tables` and
 * sensor_type_definitions under both `tables` and `referenceDataTables`
 * (it's a system-wide sensor-type catalog seeded per-environment).
 * MODULE_SCHEMAS declaration already places them in the sensor schema;
 * this migration makes the physical location match.
 *
 * # industry_templates
 *
 * industry_templates is also in MODULE_SCHEMAS[sensor].referenceDataTables
 * but has no tenantId column — not in the original 14-table RLS scope.
 * Deferred to a future reference-data consolidation commit; not blocking
 * the current teardown because SET SCHEMA for a non-tenant table is a
 * trivial follow-up.
 *
 * # See farm-service migration 1786000000000 for full architectural
 *   rationale (SET SCHEMA semantics, sequence handling, RLS policy
 *   preservation, strict ownership interaction).
 */
export class MovePublicTablesToSensor1786000100000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'MovePublicTablesToSensor1786000100000',
  );
  name = 'MovePublicTablesToSensor1786000100000';

  private readonly tables = ['channel_detection_log', 'sensor_type_definitions'];

  public async up(qr: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'sensor' AND tablename = '${table}'
          ) THEN
            ALTER TABLE public.${table} SET SCHEMA sensor;
            ALTER TABLE sensor.${table} OWNER TO sensor_service;
            ALTER TABLE sensor.${table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE sensor.${table} FORCE ROW LEVEL SECURITY;
          END IF;
        END $$;
      `);
      this.logger.log(`Ensured sensor.${table} (moved from public if needed)`);
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    for (const table of [...this.tables].reverse()) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'sensor' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) THEN
            ALTER TABLE sensor.${table} SET SCHEMA public;
            ALTER TABLE public.${table} OWNER TO shared_public_owner;
          END IF;
        END $$;
      `);
      this.logger.log(`Reverted sensor.${table} back to public`);
    }
  }
}
