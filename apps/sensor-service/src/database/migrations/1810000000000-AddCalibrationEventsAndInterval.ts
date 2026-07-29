import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-HIGH-083 (calibration status permanently false) — give calibration a
 * real per-tenant aggregate.
 *
 * Before this, `updateDataChannel` was the only write path for calibration
 * coefficients and it never stamped `lastCalibratedAt`, so every channel reported
 * "never calibrated" forever and overdue-calibration warnings could never fire.
 * This migration adds:
 *
 *   1. `sensor_data_channels.calibration_interval_days` — the per-channel schedule
 *      interval `nextCalibrationDue` is computed from (nullable → no fabricated
 *      due dates when unset).
 *   2. `calibration_events` — the append-only per-tenant history the
 *      `recordCalibration` mutation writes: actor, reference values, resulting
 *      coefficients, interval, and computed due date.
 *
 * Both `sensor_data_channels` and `calibration_events` are per-tenant tables
 * (their entities omit `schema:`), so the DDL runs against the canonical `sensor`
 * source schema AND fans out into every existing `tenant_*` schema. New tenants
 * get `calibration_events` from the source-schema clone (it is registered in
 * `MODULE_SCHEMAS['sensor'].tables`). Blue-green safe: the new column is nullable
 * and the new table starts empty, so no existing row is invalidated.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant column add +
 * per-tenant table create with tenant fan-out.
 */
export class AddCalibrationEventsAndInterval1810000000000 implements MigrationInterface {
  name = 'AddCalibrationEventsAndInterval1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Per-channel calibration interval ──────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "sensor"."sensor_data_channels" ADD COLUMN IF NOT EXISTS "calibration_interval_days" integer`,
    );
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'sensor_data_channels'
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I.sensor_data_channels ADD COLUMN IF NOT EXISTS calibration_interval_days integer',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);

    // ── 2. calibration_events (source schema) ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor"."calibration_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "channel_id" uuid NOT NULL,
        "sensor_id" uuid NOT NULL,
        "calibration_multiplier" numeric(15,6) NOT NULL,
        "calibration_offset" numeric(15,6) NOT NULL,
        "reference_values" jsonb,
        "interval_days" integer,
        "next_calibration_due" timestamptz,
        "performed_by" character varying(255) NOT NULL,
        "performed_by_email" character varying(255),
        "notes" text,
        "calibrated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_calibration_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_calibration_events_channel"
         ON "sensor"."calibration_events" ("tenant_id", "channel_id", "calibrated_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_calibration_events_sensor"
         ON "sensor"."calibration_events" ("tenant_id", "sensor_id")`,
    );

    // ── 3. Fan the new table out into every existing tenant schema ───────────
    // CREATE TABLE … LIKE INCLUDING ALL clones the columns, defaults, primary key,
    // and indexes with fresh (schema-scoped) index names — the same mechanism the
    // provisioner uses for per-tenant fan-out.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'sensor_data_channels'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'calibration_events'
          ) THEN
            EXECUTE format(
              'CREATE TABLE %I.calibration_events (LIKE sensor.calibration_events INCLUDING ALL)',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the per-tenant calibration_events clones first, then the source table.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'calibration_events'
          ) THEN
            EXECUTE format('DROP TABLE IF EXISTS %I.calibration_events', r.nspname);
          END IF;
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor"."calibration_events"`);

    await queryRunner.query(
      `ALTER TABLE "sensor"."sensor_data_channels" DROP COLUMN IF EXISTS "calibration_interval_days"`,
    );
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'sensor_data_channels'
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I.sensor_data_channels DROP COLUMN IF EXISTS calibration_interval_days',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);
  }
}
