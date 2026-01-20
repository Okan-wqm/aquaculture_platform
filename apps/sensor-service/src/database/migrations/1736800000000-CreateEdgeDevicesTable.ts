import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create Edge Devices Source Table
 *
 * Creates the edge_devices table in the sensor schema as a source table
 * for multi-tenant schema replication.
 *
 * This table stores industrial edge controllers (Revolution Pi, Raspberry Pi, etc.)
 * with full IEC 62443 security compliance and zero-touch provisioning support.
 */
export class CreateEdgeDevicesTable1736800000000 implements MigrationInterface {
  name = 'CreateEdgeDevicesTable1736800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running CreateEdgeDevicesTable migration in schema:', schema);

    // Check if table already exists
    const tableExists = await this.tableExists(queryRunner, 'edge_devices');
    if (tableExists) {
      console.log('edge_devices table already exists, skipping creation');
      return;
    }

    // 1. Create DeviceLifecycleState enum if not exists
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE device_lifecycle_state AS ENUM (
          'registered',
          'provisioning',
          'pending_approval',
          'active',
          'offline',
          'maintenance',
          'error',
          'revoked',
          'decommissioned'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    console.log('Created device_lifecycle_state enum');

    // 2. Create DeviceModel enum if not exists
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE device_model AS ENUM (
          'revolution_pi_connect_4',
          'revolution_pi_compact',
          'raspberry_pi_4',
          'raspberry_pi_5',
          'industrial_pc',
          'custom'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    console.log('Created device_model enum');

    // 3. Create edge_devices table matching entity EXACTLY
    await queryRunner.query(`
      CREATE TABLE "edge_devices" (
        -- Identity
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" UUID NOT NULL,
        "site_id" UUID,
        "device_code" VARCHAR(50) NOT NULL,
        "device_name" VARCHAR(100) NOT NULL,
        "device_model" device_model NOT NULL DEFAULT 'custom',
        "serial_number" VARCHAR(100),
        "description" TEXT,

        -- Lifecycle
        "lifecycle_state" device_lifecycle_state NOT NULL DEFAULT 'registered',
        "commissioned_at" TIMESTAMPTZ,
        "commissioned_by" UUID,

        -- Security (IEC 62443)
        "mqtt_client_id" VARCHAR(100),
        "certificate_thumbprint" VARCHAR(64),
        "certificate_expires_at" TIMESTAMPTZ,
        "security_level" INTEGER DEFAULT 2,

        -- Provisioning
        "provisioning_token" VARCHAR(64),
        "token_expires_at" TIMESTAMPTZ,
        "token_used_at" TIMESTAMPTZ,
        "mqtt_password_hash" VARCHAR(128),
        "fingerprint" JSONB,
        "agent_version" VARCHAR(30),

        -- Connection
        "last_seen_at" TIMESTAMPTZ,
        "is_online" BOOLEAN DEFAULT false,
        "connection_quality" INTEGER,
        "ip_address" INET,

        -- Firmware
        "firmware_version" VARCHAR(30),
        "firmware_updated_at" TIMESTAMPTZ,
        "target_firmware_version" VARCHAR(30),

        -- Health Metrics
        "cpu_usage" INTEGER,
        "memory_usage" INTEGER,
        "storage_usage" INTEGER,
        "temperature_celsius" DECIMAL(5,2),
        "uptime_seconds" BIGINT,

        -- Configuration
        "timezone" VARCHAR(50) DEFAULT 'UTC',
        "scan_rate_ms" INTEGER DEFAULT 100,
        "config" JSONB,
        "capabilities" JSONB,
        "tags" JSONB,

        -- Timestamps
        "created_at" TIMESTAMPTZ DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ DEFAULT NOW(),
        "created_by" UUID
      )
    `);
    console.log('Created edge_devices table');

    // 4. Create indexes matching entity @Index decorators
    await queryRunner.query(`
      CREATE INDEX "IDX_edge_devices_tenant"
      ON "edge_devices" ("tenant_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_edge_devices_tenant_lifecycle"
      ON "edge_devices" ("tenant_id", "lifecycle_state")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_edge_devices_tenant_site"
      ON "edge_devices" ("tenant_id", "site_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_edge_devices_code"
      ON "edge_devices" ("device_code")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_edge_devices_mqtt_client"
      ON "edge_devices" ("mqtt_client_id")
      WHERE "mqtt_client_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_edge_devices_serial"
      ON "edge_devices" ("serial_number")
      WHERE "serial_number" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_edge_devices_site"
      ON "edge_devices" ("site_id")
      WHERE "site_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_edge_devices_online"
      ON "edge_devices" ("is_online", "last_seen_at" DESC)
      WHERE "is_online" = true
    `);

    console.log('Created indexes for edge_devices');

    // 5. Create trigger for updated_at
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_edge_devices_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trigger_edge_devices_updated_at ON "edge_devices";
      CREATE TRIGGER trigger_edge_devices_updated_at
      BEFORE UPDATE ON "edge_devices"
      FOR EACH ROW
      EXECUTE FUNCTION update_edge_devices_updated_at()
    `);

    console.log('Created updated_at trigger for edge_devices');
    console.log('CreateEdgeDevicesTable migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop trigger
    await queryRunner.query(`DROP TRIGGER IF EXISTS trigger_edge_devices_updated_at ON "edge_devices"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS update_edge_devices_updated_at()`);

    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_tenant"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_tenant_lifecycle"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_tenant_site"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_mqtt_client"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_serial"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_site"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_edge_devices_online"`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_devices"`);

    // Drop enums
    await queryRunner.query(`DROP TYPE IF EXISTS device_lifecycle_state`);
    await queryRunner.query(`DROP TYPE IF EXISTS device_model`);

    console.log('Rolled back CreateEdgeDevicesTable migration');
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = $1
      )
    `, [tableName]);
    return result[0]?.exists === true;
  }
}
