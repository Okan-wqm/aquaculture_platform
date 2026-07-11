import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-HIGH-026: the VFD registration wizard collects modelSeries, pumpId and
 * tags but the vfd_devices table had no backing columns, so the values were
 * validated then silently dropped at persistence.
 *
 * vfd_devices is a per-tenant table (schema-per-tenant), so the columns are
 * added to the canonical `sensor` source schema AND to every existing
 * `tenant_*` schema. All columns are nullable → blue-green safe (add column →
 * backfill later if ever needed → no NOT NULL). ADD COLUMN IF NOT EXISTS makes
 * the migration idempotent across the source + tenant fan-out.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant column add.
 */
export class AddVfdDeviceModelSeriesPumpTags1802000000000 implements MigrationInterface {
  name = 'AddVfdDeviceModelSeriesPumpTags1802000000000';

  private readonly columns: ReadonlyArray<{ name: string; type: string }> = [
    { name: 'model_series', type: 'character varying(100)' },
    { name: 'pump_id', type: 'uuid' },
    { name: 'tags', type: 'jsonb' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Canonical source schema.
    for (const col of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "sensor"."vfd_devices" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`,
      );
    }

    // Fan out to every provisioned tenant schema that holds vfd_devices.
    for (const col of this.columns) {
      await queryRunner.query(`
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN
            SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
          LOOP
            IF EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = r.nspname AND table_name = 'vfd_devices'
            ) THEN
              EXECUTE format(
                'ALTER TABLE %I.vfd_devices ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}',
                r.nspname
              );
            END IF;
          END LOOP;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const col of [...this.columns].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "sensor"."vfd_devices" DROP COLUMN IF EXISTS "${col.name}"`,
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
              WHERE table_schema = r.nspname AND table_name = 'vfd_devices'
            ) THEN
              EXECUTE format(
                'ALTER TABLE %I.vfd_devices DROP COLUMN IF EXISTS ${col.name}',
                r.nspname
              );
            END IF;
          END LOOP;
        END $$;
      `);
    }
  }
}
