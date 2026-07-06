import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-MEDIUM-004: cross-tenant O(1) device→tenant index.
 *
 * Public provisioning + MQTT-auth endpoints have no tenant context and used to
 * resolve a device by UNION-ALL scanning edge_devices across EVERY tenant
 * schema on each uncached request — O(number of tenants), unbounded on the
 * un-rate-limited MQTT-auth path (a DoS lever). This creates a single
 * cross-tenant directory in the `sensor` schema so a device resolves to its
 * tenant with one indexed lookup, and backfills it from the existing
 * per-tenant edge_devices rows.
 *
 * Cross-tenant infrastructure table (MODULE_SCHEMAS['sensor'].infrastructureTables) —
 * one table in `sensor`, never per-tenant cloned. Blue-green safe: additive
 * only, no column dropped or set NOT NULL on an existing table.
 */
export class CreateEdgeDeviceDirectory1805000000000 implements MigrationInterface {
  name = 'CreateEdgeDeviceDirectory1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.edge_device_directory (
        device_id uuid PRIMARY KEY,
        device_code varchar(50) NOT NULL,
        mqtt_client_id varchar(200),
        tenant_id uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Plain (non-unique) indexes: device_code is only per-tenant unique in the
    // source, so a global UNIQUE would fail the insert on a rare cross-tenant
    // collision. The lookups resolve LIMIT 1, matching the pre-existing scan.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_edge_device_directory_device_code
         ON sensor.edge_device_directory (device_code)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_edge_device_directory_mqtt_client_id
         ON sensor.edge_device_directory (mqtt_client_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_edge_device_directory_tenant_id
         ON sensor.edge_device_directory (tenant_id)`,
    );

    // Backfill from every provisioned tenant schema. ON CONFLICT DO NOTHING so
    // a re-run (or a device_code/mqtt_client_id already present) is a no-op.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'edge_devices'
          ) THEN
            EXECUTE format(
              'INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
               SELECT id, device_code, mqtt_client_id, tenant_id FROM %I.edge_devices
               ON CONFLICT DO NOTHING',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Idempotent teardown; the directory is a derived index (edge_devices is the
    // source of truth) so dropping it loses no authoritative data.
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.edge_device_directory`);
  }
}
