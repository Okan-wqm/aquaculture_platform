import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-HIGH-064 (honest I/O config-push ack) — track the config an edge device
 * has actually CONFIRMED applying.
 *
 * `pushIoConfigToDevice` used to report unconditional green the instant it
 * published `update_io_config`, and the device ack was dead code. The fix
 * correlates the edge `CommandResponse` back to the push by commandId and records
 * the confirmed state here: `applied_config_hash` is the content hash of the agent
 * config the device acknowledged, and `last_config_ack_at` is when that ack
 * arrived. The operator can now see the truthful applied state instead of an
 * optimistic "pushed" state.
 *
 * edge_devices is a per-tenant table (schema-per-tenant), so the columns are added
 * to the canonical `sensor` source schema AND to every existing `tenant_*` schema.
 * Both columns are nullable → blue-green safe (add column → populate on the next
 * confirmed push → never NOT NULL). ADD COLUMN IF NOT EXISTS keeps the migration
 * idempotent across the source + tenant fan-out.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant column add.
 */
export class AddEdgeDeviceConfigAckTracking1809000000000 implements MigrationInterface {
  name = 'AddEdgeDeviceConfigAckTracking1809000000000';

  private readonly columns: ReadonlyArray<{ name: string; type: string }> = [
    { name: 'applied_config_hash', type: 'character varying(64)' },
    { name: 'last_config_ack_at', type: 'timestamptz' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Canonical source schema.
    for (const col of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "sensor"."edge_devices" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`,
      );
    }

    // Fan out to every provisioned tenant schema that holds edge_devices.
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
              WHERE table_schema = r.nspname AND table_name = 'edge_devices'
            ) THEN
              EXECUTE format(
                'ALTER TABLE %I.edge_devices ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}',
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
        `ALTER TABLE "sensor"."edge_devices" DROP COLUMN IF EXISTS "${col.name}"`,
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
              WHERE table_schema = r.nspname AND table_name = 'edge_devices'
            ) THEN
              EXECUTE format(
                'ALTER TABLE %I.edge_devices DROP COLUMN IF EXISTS ${col.name}',
                r.nspname
              );
            END IF;
          END LOOP;
        END $$;
      `);
    }
  }
}
