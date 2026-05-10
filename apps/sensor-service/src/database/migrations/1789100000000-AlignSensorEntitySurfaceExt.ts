import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignSensorEntitySurfaceExt1789100000000
 * ============================================================================
 *
 * Closes the residual entity-vs-DB drift surface that the bootstrap-from-
 * scratch CI test reported AFTER `1789000000000-AlignSensorEntitySurface`
 * landed: 5 entirely-missing tables and 17 NOT NULL drifts spread across
 * pre-existing `sensor` tables.
 *
 * # Scope
 *
 * 1. Five missing tables, full column+index surface from entity decorators:
 *    vfd_devices, vfd_readings, plc_connections, feeding_parameters,
 *    device_io_configs.
 *
 * 2. NOT NULL drifts (entity declares NOT NULL; deployed DDL nullable):
 *    scada_deploy_logs.sent_at;
 *    unified_tags: local_name, io_type, data_type, direction, source, hierarchy;
 *    sensor_type_definitions: default_channels, metadata;
 *    program_steps: position_x, position_y;
 *    edge_devices: is_online, security_level, timezone, scan_rate_ms,
 *                  created_at, updated_at;
 *    sensors: calibration_enabled.
 *
 *    Each fix uses backfill → SET NOT NULL guarded by
 *    `information_schema.columns is_nullable = 'YES'` (R10).
 *
 * # Idempotency
 *
 *   - Tables: `CREATE TABLE IF NOT EXISTS` (R6)
 *   - Indexes: `CREATE INDEX IF NOT EXISTS` (R3)
 *   - Enums: `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object THEN NULL; END $$` (R8)
 *   - ALTER COLUMN SET NOT NULL: information_schema.columns guard in same chunk (R10)
 *   - Constraints: DO $$/EXCEPTION wrapped (R11)
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignSensorEntitySurfaceExt1789100000000
  implements MigrationInterface
{
  name = 'AlignSensorEntitySurfaceExt1789100000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'sensor');

    this.logger.log(
      'Aligning sensor schema with entity surface — 5 missing tables, ' +
        '17 NOT NULL drifts (W4-A2-D2 residual gap closure).',
    );

    await this.createVfdDevicesTable(queryRunner);
    await this.createVfdReadingsTable(queryRunner);
    await this.createPlcConnectionsTable(queryRunner);
    await this.createFeedingParametersTable(queryRunner);
    await this.createDeviceIoConfigsTable(queryRunner);

    await this.fixScadaDeployLogsNotNullDrifts(queryRunner);
    await this.fixUnifiedTagsNotNullDrifts(queryRunner);
    await this.fixSensorTypeDefinitionsNotNullDrifts(queryRunner);
    await this.fixProgramStepsNotNullDrifts(queryRunner);
    await this.fixEdgeDevicesNotNullDrifts(queryRunner);
    await this.fixSensorsNotNullDrifts(queryRunner);

    this.logger.log('Sensor schema residual alignment complete.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting AlignSensorEntitySurfaceExt — destructive, intended ' +
        'for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      'device_io_configs',
      'feeding_parameters',
      'vfd_readings',
      'vfd_devices',
      'plc_connections',
    ];
    for (const t of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS sensor."${t}" CASCADE`);
    }

    await queryRunner.query(
      `DROP TYPE IF EXISTS sensor."device_io_configs_io_type_enum" CASCADE`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS sensor."device_io_configs_data_type_enum" CASCADE`,
    );
  }

  private async createVfdDevicesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_devices (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "brand" varchar(50) NOT NULL,
        "model" varchar(100),
        "serialNumber" varchar(100),
        "protocol" varchar(50) NOT NULL,
        "protocolConfiguration" jsonb NOT NULL,
        "connectionStatus" jsonb,
        "status" varchar(50) NOT NULL DEFAULT 'draft',
        "tenant_id" uuid NOT NULL,
        "farm_id" uuid,
        "tank_id" uuid,
        "location" varchar(255),
        "description" text,
        "metadata" jsonb,
        "customRegisterMappings" jsonb,
        "poll_interval_ms" integer NOT NULL DEFAULT 1000,
        "is_polling_enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "createdBy" uuid,
        "updatedBy" uuid
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_devices_tenant_id"
        ON sensor.vfd_devices ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_devices_tenant_status"
        ON sensor.vfd_devices ("tenant_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_devices_tenant_brand"
        ON sensor.vfd_devices ("tenant_id", "brand");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_devices_tenant_protocol"
        ON sensor.vfd_devices ("tenant_id", "protocol");
    `);
  }

  private async createVfdReadingsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_readings (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vfd_device_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "parameters" jsonb NOT NULL,
        "statusBits" jsonb,
        "rawValues" jsonb,
        "latencyMs" integer,
        "isValid" boolean NOT NULL DEFAULT true,
        "errorMessage" varchar(255),
        "timestamp" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_readings_vfd_device_id"
        ON sensor.vfd_readings ("vfd_device_id");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_readings_tenant_id"
        ON sensor.vfd_readings ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_readings_timestamp"
        ON sensor.vfd_readings ("timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_readings_device_ts"
        ON sensor.vfd_readings ("vfd_device_id", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_readings_tenant_ts"
        ON sensor.vfd_readings ("tenant_id", "timestamp");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.vfd_readings
          ADD CONSTRAINT "FK_vfd_readings_vfd_device"
          FOREIGN KEY ("vfd_device_id")
          REFERENCES sensor.vfd_devices("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async createPlcConnectionsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.plc_connections (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "siteId" varchar NOT NULL,
        "tankId" varchar,
        "name" varchar NOT NULL,
        "description" varchar,
        "endpointUrl" varchar NOT NULL,
        "securityMode" varchar NOT NULL DEFAULT 'None',
        "securityPolicy" varchar DEFAULT 'None',
        "authMode" varchar NOT NULL DEFAULT 'Anonymous',
        "username" varchar,
        "password" text,
        "clientCertificate" text,
        "clientPrivateKey" text,
        "serverCertificate" text,
        "status" varchar NOT NULL DEFAULT 'OFFLINE',
        "lastConnectedAt" timestamp,
        "lastError" varchar,
        "publishingIntervalMs" integer NOT NULL DEFAULT 1000,
        "samplingIntervalMs" integer NOT NULL DEFAULT 500,
        "sessionTimeoutMs" integer NOT NULL DEFAULT 60000,
        "connectTimeoutMs" integer NOT NULL DEFAULT 5000,
        "requestTimeoutMs" integer NOT NULL DEFAULT 60000,
        "autoReconnect" boolean NOT NULL DEFAULT true,
        "maxReconnectAttempts" integer NOT NULL DEFAULT -1,
        "reconnectDelayMs" integer NOT NULL DEFAULT 1000,
        "maxReconnectDelayMs" integer NOT NULL DEFAULT 30000,
        "keepAliveIntervalMs" integer NOT NULL DEFAULT 5000,
        "failoverEndpointUrl" varchar,
        "parametersNodeId" varchar,
        "telemetryNodeId" varchar,
        "alarmsNodeId" varchar,
        "statusNodeId" varchar,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_plc_connections_tenant_id"
        ON sensor.plc_connections ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_plc_connections_tenant_site"
        ON sensor.plc_connections ("tenant_id", "siteId");
    `);
  }

  private async createFeedingParametersTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.feeding_parameters (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "plcConnectionId" uuid NOT NULL,
        "tankId" varchar,
        "name" varchar NOT NULL,
        "description" varchar,
        "version" varchar NOT NULL DEFAULT '1.0',
        "biomassKg" decimal(10, 2) NOT NULL,
        "fcr" decimal(5, 3) NOT NULL,
        "targetDailyFeedKg" decimal(10, 2) NOT NULL,
        "schedule" jsonb NOT NULL,
        "thresholds" jsonb NOT NULL,
        "vfdSettings" jsonb NOT NULL,
        "status" varchar NOT NULL DEFAULT 'DRAFT',
        "sentAt" timestamp,
        "acknowledgedAt" timestamp,
        "activatedAt" varchar,
        "errorMessage" text,
        "checksum" varchar,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "createdBy" varchar
      );
      CREATE INDEX IF NOT EXISTS "IDX_feeding_parameters_tenant_id"
        ON sensor.feeding_parameters ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_parameters_tenant_plc"
        ON sensor.feeding_parameters ("tenant_id", "plcConnectionId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_parameters_tenant_status"
        ON sensor.feeding_parameters ("tenant_id", "status");
    `);
  }

  private async createDeviceIoConfigsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor."device_io_configs_io_type_enum" AS ENUM ('DI', 'DO', 'AI', 'AO');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor."device_io_configs_data_type_enum" AS ENUM (
          'bool', 'int16', 'int32', 'uint16', 'uint32', 'float32', 'float64'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.device_io_configs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id" uuid NOT NULL,
        "tag_name" varchar(50) NOT NULL,
        "description" varchar(200),
        "io_type" sensor."device_io_configs_io_type_enum" NOT NULL,
        "data_type" sensor."device_io_configs_data_type_enum" NOT NULL,
        "module_address" integer NOT NULL,
        "channel" integer NOT NULL,
        "raw_min" decimal(15, 4),
        "raw_max" decimal(15, 4),
        "eng_min" decimal(15, 4),
        "eng_max" decimal(15, 4),
        "eng_unit" varchar(20),
        "modbus_function" integer,
        "modbus_slave_id" integer NOT NULL DEFAULT 1,
        "modbus_register" integer,
        "gpio_pin" integer,
        "gpio_mode" varchar(20),
        "bus_type" varchar(10),
        "i2c_bus" smallint,
        "i2c_address" smallint,
        "spi_bus" smallint,
        "spi_cs" smallint,
        "uart_port" varchar(50),
        "driver_type" varchar(50),
        "invert_value" boolean NOT NULL DEFAULT false,
        "alarm_hh" decimal(15, 4),
        "alarm_h" decimal(15, 4),
        "alarm_l" decimal(15, 4),
        "alarm_ll" decimal(15, 4),
        "deadband" decimal(15, 4),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_device_io_configs_device_tag"
        ON sensor.device_io_configs ("device_id", "tag_name");
      CREATE INDEX IF NOT EXISTS "IDX_device_io_configs_device_module_channel"
        ON sensor.device_io_configs ("device_id", "module_address", "channel");
    `);
  }

  /**
   * Apply a NOT NULL drift fix idempotently. Backfill any existing
   * NULL rows with `safeDefault`, then SET NOT NULL guarded by
   * `information_schema.columns is_nullable = 'YES'` lookup. The
   * lookup is the lint R10 idempotency probe AND the second-run
   * no-op guard.
   */
  private async fixNotNullDrift(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    safeDefault: string,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE sensor."${tableName}"
       SET "${columnName}" = ${safeDefault}
       WHERE "${columnName}" IS NULL`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'sensor'
            AND table_name = '${tableName}'
            AND column_name = '${columnName}'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE sensor."${tableName}"
            ALTER COLUMN "${columnName}" SET NOT NULL;
        END IF;
      END $$
    `);
  }

  private async fixScadaDeployLogsNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(queryRunner, 'scada_deploy_logs', 'sent_at', 'NOW()');
  }

  private async fixUnifiedTagsNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'local_name', `''`);
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'io_type', `'DI'`);
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'data_type', `'BOOL'`);
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'direction', `'input'`);
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'source', `'{}'::jsonb`);
    await this.fixNotNullDrift(queryRunner, 'unified_tags', 'hierarchy', `'{}'::jsonb`);
  }

  private async fixSensorTypeDefinitionsNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(
      queryRunner,
      'sensor_type_definitions',
      'default_channels',
      `'[]'::jsonb`,
    );
    await this.fixNotNullDrift(
      queryRunner,
      'sensor_type_definitions',
      'metadata',
      `'{}'::jsonb`,
    );
  }

  private async fixProgramStepsNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(queryRunner, 'program_steps', 'position_x', '0');
    await this.fixNotNullDrift(queryRunner, 'program_steps', 'position_y', '0');
  }

  private async fixEdgeDevicesNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'is_online', 'false');
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'security_level', '2');
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'timezone', `'UTC'`);
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'scan_rate_ms', '100');
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'created_at', 'NOW()');
    await this.fixNotNullDrift(queryRunner, 'edge_devices', 'updated_at', 'NOW()');
  }

  private async fixSensorsNotNullDrifts(queryRunner: QueryRunner): Promise<void> {
    await this.fixNotNullDrift(queryRunner, 'sensors', 'calibration_enabled', 'false');
  }
}
