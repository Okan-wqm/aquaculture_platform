import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-MEDIUM-068 (reading-store convergence, Phase 2A): sensor_metrics is now
 * the single cross-tenant TimescaleDB hypertable in the `sensor` schema — it was
 * reclassified from `tables` to `infrastructureTables`, the entity pins
 * `schema: 'sensor'`, and every read/write is schema-qualified
 * `sensor.sensor_metrics`. The historical per-tenant clones — plain
 * (non-hypertable) tables created by the one-time CREATE-TABLE-LIKE tenant
 * fan-out — are now dead weight no code reads or writes (background writers
 * always hit the source hypertable; the MQTT saveReading path that used to write
 * the tenant clone now targets sensor.sensor_metrics too).
 *
 * This migration consolidates onto the single `sensor.sensor_metrics`: for every
 * tenant schema it copies any rows up into the source hypertable
 * (ON CONFLICT DO NOTHING — preserve before drop, blue-green safe) and then drops
 * the clone. The canonical `sensor.sensor_metrics` hypertable (created in
 * Baseline) is left in place; the DO-block iterates ONLY `tenant_<hex>` schemas
 * and qualifies each clone explicitly (`%I.sensor_metrics`), so the source
 * hypertable is never a DROP target.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant clone teardown.
 */
export class ConsolidateSensorMetricsToSensorSchema1813000000000 implements MigrationInterface {
  name = 'ConsolidateSensorMetricsToSensorSchema1813000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure the canonical source hypertable exists before absorbing clone rows.
    const sourceExists: { exists: boolean }[] = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'sensor' AND table_name = 'sensor_metrics'
       ) AS exists`,
    );
    if (!sourceExists[0]?.exists) {
      // Nothing to consolidate into — leave tenant clones untouched rather than
      // dropping data with no home. (Baseline always creates the source table.)
      return;
    }

    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'sensor_metrics'
          ) THEN
            -- Preserve any rows written by the pre-convergence MQTT saveReading
            -- path (which wrote the tenant clone) before dropping. The clone is a
            -- LIKE-clone of the source so column order matches; ON CONFLICT DO
            -- NOTHING keeps the source hypertable's row on any
            -- (time, sensor_id, channel_id) collision.
            EXECUTE format(
              'INSERT INTO sensor.sensor_metrics SELECT * FROM %I.sensor_metrics ON CONFLICT DO NOTHING',
              r.nspname
            );
            -- DESTRUCTIVE (SENSOR-MEDIUM-068): removes the per-tenant
            -- sensor_metrics clone (a plain, non-hypertable table). Any rows were
            -- copied up to the source hypertable on the INSERT above, before
            -- removal, so no data is lost. The clone is explicitly qualified
            -- (%I = tenant_<hex>), so the source sensor.sensor_metrics hypertable
            -- is never a DROP target. Rollback: re-run the historical per-tenant
            -- fan-out — but that re-introduces the split-store defect. A pg_dump
            -- backup of every clone is taken by the standard pre-migration ops
            -- stage-gate; space is reclaimed immediately.
            EXECUTE format('DROP TABLE IF EXISTS %I.sensor_metrics', r.nspname);
          END IF;
          -- Belt-and-suspenders: the Rust sidecar's per-tenant
          -- sensor_metrics_stage was pilot-only and was never created by any DDL,
          -- but drop it if an operator hand-created one so no orphan lingers.
          EXECUTE format('DROP TABLE IF EXISTS %I.sensor_metrics_stage', r.nspname);
        END LOOP;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Irreversible by design: the per-tenant clones were dead weight after the
    // cross-tenant reclassification. Re-creating them would re-introduce the
    // split-store defect (SENSOR-MEDIUM-068). The canonical sensor.sensor_metrics
    // hypertable remains the single source.
  }
}
