import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-CRITICAL-007 (edge-delegated VFD write, Faz 1 Slice 1) — bind a VFD
 * record to the edge gateway that physically fronts the drive.
 *
 * The production I/O path for actuator writes is the edge Rust gateway (ADR-025
 * write model): the cloud never opens a socket to the drive, it publishes a
 * signed `write_modbus` command envelope to the owning edge device, which does
 * the hardened, readback-verified write. To route that envelope the VFD record
 * must know (a) which edge gateway owns it (`edge_device_id` → edge_devices.id,
 * the MQTT command-topic addressee) and (b) the Modbus `device` name that
 * gateway's I/O config exposes for this drive (`edge_modbus_device_name`, the
 * `params.device` of the write_modbus verb). Until now VFD writes ran entirely
 * cloud-direct, so these had no backing columns.
 *
 * vfd_devices is a per-tenant table (schema-per-tenant), so the columns are
 * added to the canonical `sensor` source schema AND to every existing
 * `tenant_*` schema. Both columns are nullable → blue-green safe (add column →
 * populate via registration/update → never NOT NULL). ADD COLUMN IF NOT EXISTS
 * keeps the migration idempotent across the source + tenant fan-out.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant column add.
 */
export class AddVfdDeviceEdgeBinding1808000000000 implements MigrationInterface {
  name = 'AddVfdDeviceEdgeBinding1808000000000';

  private readonly columns: ReadonlyArray<{ name: string; type: string }> = [
    { name: 'edge_device_id', type: 'uuid' },
    { name: 'edge_modbus_device_name', type: 'character varying(255)' },
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
