import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateSensorBaselineTables1735850000000
 * ============================================================================
 *
 * Restores the sensor-service migration baseline that was lost when several
 * earlier `CREATE TABLE` migrations were squashed out of source. On a
 * fresh-volume bootstrap, the surviving migration chain
 * (1735900000000+) assumes baseline tables that no longer have a
 * creation step.
 *
 * Concrete failures on a fresh DB without this migration:
 *
 *   - `1735900000000-CreateSensorMetrics` ALTERs `sensor_data_channels`
 *     to add `unit_symbol`, `physical_min`, `physical_max`,
 *     `operational_min`, `operational_max`, `next_calibration_due`,
 *     `calibration_polynomial`, `protocol_config` — but the table is
 *     never created in the surviving migration set.
 *   - `1740200000000-CreateDynamicSensorTypes` adds `type_definition_id`
 *     to `sensors`, conditional on the table existing — without this
 *     baseline the column is silently skipped, leaving the live
 *     `Sensor` entity's `typeDefinitionId` field unbacked.
 *   - `1741200000000-EnterprisePerformanceOptimizations` issues
 *     `CREATE INDEX ... ON sensors (...)` and `ALTER TABLE sensors`
 *     statements that fail without the table.
 *   - `1781400000000-AddSensorProtocolTopicIndex` indexes
 *     `sensor_protocols.configurationSchema->>'topic'` — fails without
 *     `sensor_protocols`.
 *   - The `TenantSchemaSyncService` clones source-schema tables into
 *     `tenant_<uuid>` via `CREATE TABLE LIKE INCLUDING ALL`. Missing
 *     source tables silently skip the clone step, so per-tenant tables
 *     such as `sensors`, `dashboard_layouts`, `device_groups`,
 *     `lora_devices`, `tenant_provisioning_keys` would never appear.
 *
 * # Scope
 *
 *   1. Create 13 Postgres enum types idempotently — every enum that the
 *      8 tables below declare via `@Column({ type: 'enum', ... })`.
 *   2. Create 8 baseline `sensor.*` tables idempotently in topological
 *      FK order:
 *        sensor_protocols (no FKs)
 *        sensors (FK protocol_id → sensor_protocols, parent_id → self)
 *        sensor_data_channels (FK sensor_id → sensors)
 *        dashboard_layouts (no DB FKs — process_background is JSONB)
 *        device_groups (FK parent_group_id → self)
 *        device_group_members (FK group_id → device_groups)
 *        tenant_provisioning_keys (no FKs)
 *        lora_devices (FK to edge_devices installed by sibling migration — see below)
 *
 * # Why not extend 1735800000000-CreateSensorReadingsHypertable
 *
 * That migration is single-purpose: TimescaleDB hypertable + retention
 * + compression policies for `sensor_readings`. Mixing 8 unrelated
 * tables into it would obscure the hypertable lifecycle and complicate
 * the down() symmetry. Splitting into a sibling baseline at
 * `1735850000000` (between `sensor_readings` at 1735800000000 and
 * `sensor_metrics` at 1735900000000) keeps each migration's purpose
 * narrow.
 *
 * # FK to edge_devices is installed by a sibling migration
 *
 * `lora_devices.edge_device_id` is declared with `@ManyToOne(() =>
 * EdgeDevice, { onDelete: 'CASCADE' })` in the entity, but `edge_devices`
 * is created later by `1736800000000-CreateEdgeDevicesTable`. Adding the
 * FK here would target a non-existent parent. The FK is added by a
 * follow-up migration (`1736800001000-AddLoraDevicesEdgeDeviceFk`)
 * immediately after `edge_devices` is created — that is the
 * architectural seam where the FK first becomes valid. This mirrors the
 * pattern `1740200000000-CreateDynamicSensorTypes` uses to attach
 * `sensors.type_definition_id` AFTER the dependent table is in place.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (tables, columns, indexes)
 * and `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL` blocks for
 * enum types and FK constraints. A second run is a no-op. This is
 * required because:
 *
 *   - The migration ledger only inserts the entry once, but a partial
 *     first-run failure (e.g. transient network) may leave some objects
 *     already created when the migration is retried.
 *   - `device_groups` and `device_group_members` are also created
 *     `IF NOT EXISTS` by `1741200000000-EnterprisePerformanceOptimizations`
 *     — that migration becomes a no-op for these two tables once this
 *     baseline runs first; the column lists are kept compatible.
 *
 * # Schema qualification
 *
 * Tables are created with unqualified names so search_path
 * (= `sensor, public`, pinned by MigrationRunnerService) routes them
 * to the `sensor` source schema. This matches the surviving sibling
 * migrations (`1735800000000`, `1735900000000`) which all use
 * unqualified DDL — required so that
 * `TenantSchemaSyncService.cloneSourceSchema()` can later run
 * `CREATE TABLE LIKE INCLUDING ALL` against per-tenant clones.
 *
 * # CREATE INDEX bundling (R3 hint from migration-sql-lint)
 *
 * `CREATE INDEX` statements are bundled with their `CREATE TABLE` in a
 * single `queryRunner.query(...)` template literal so the migration-sql-
 * lint R3 just-created-table exemption applies. Same pattern used by
 * `1735800000000-CreateSensorReadingsHypertable`.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateSensorBaselineTables1735850000000
  implements MigrationInterface
{
  name = 'CreateSensorBaselineTables1735850000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline sensor.* tables (8) and enum types (13)',
    );

    // The sensor schema itself is created by infrastructure/docker/init-
    // scripts. Defensive guard for direct CLI runs against a bare DB.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS sensor`);

    await this.createEnumTypes(queryRunner);

    // Topological FK order: parents first, children second.
    await this.createSensorProtocolsTable(queryRunner);
    await this.createSensorsTable(queryRunner);
    await this.createSensorDataChannelsTable(queryRunner);
    await this.createDashboardLayoutsTable(queryRunner);
    await this.createDeviceGroupsTable(queryRunner);
    await this.createDeviceGroupMembersTable(queryRunner);
    await this.createTenantProvisioningKeysTable(queryRunner);
    await this.createLoraDevicesTable(queryRunner);

    this.logger.log('Baseline sensor schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, parents second, enums last.
    this.logger.warn(
      'Reverting baseline sensor.* tables. ' +
        'This is destructive and is intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      'lora_devices',
      'tenant_provisioning_keys',
      'device_group_members',
      'device_groups',
      'dashboard_layouts',
      'sensor_data_channels',
      'sensors',
      'sensor_protocols',
    ];
    for (const table of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    const enumTypes = [
      'lora_device_class_enum',
      'lora_activation_mode_enum',
      'connection_type_enum',
      'protocol_subcategory_enum',
      'protocol_category_enum',
      'discovery_source_enum',
      'channel_data_type_enum',
      'sensor_role_enum',
      'sensor_registration_status_enum',
      'sensor_status_enum',
      'sensor_type_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${enumType}" CASCADE`);
    }
  }

  /**
   * Create Postgres enum types for the 8 baseline tables. Names use the
   * unprefixed form because the `sensor` schema already owns them via
   * search_path qualification — and the entity decorators reference them
   * by their bare TypeScript enum class names (TypeORM auto-derives the
   * Postgres type name from the column name + enum class).
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent (Postgres lacks `CREATE TYPE IF NOT EXISTS`).
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      // sensor.entity.ts: SensorType
      {
        name: 'sensor_type_enum',
        values: [
          'temperature',
          'ph',
          'dissolved_oxygen',
          'salinity',
          'ammonia',
          'nitrite',
          'nitrate',
          'turbidity',
          'water_level',
          'multi_parameter',
          'flow_rate',
          'conductivity',
          'orp',
          'chlorine',
          'co2',
        ],
      },
      // sensor.entity.ts: SensorStatus
      {
        name: 'sensor_status_enum',
        values: ['active', 'inactive', 'maintenance', 'error', 'offline'],
      },
      // sensor.entity.ts: SensorRegistrationStatus
      {
        name: 'sensor_registration_status_enum',
        values: [
          'draft',
          'pending_test',
          'testing',
          'test_failed',
          'active',
          'suspended',
        ],
      },
      // sensor.entity.ts: SensorRole
      { name: 'sensor_role_enum', values: ['parent', 'child'] },
      // sensor-data-channel.entity.ts: ChannelDataType
      {
        name: 'channel_data_type_enum',
        values: ['number', 'boolean', 'string', 'enum'],
      },
      // sensor-data-channel.entity.ts: DiscoverySource
      {
        name: 'discovery_source_enum',
        values: ['auto', 'manual', 'template'],
      },
      // sensor-protocol.entity.ts: ProtocolCategory
      {
        name: 'protocol_category_enum',
        values: ['industrial', 'iot', 'serial', 'wireless'],
      },
      // sensor-protocol.entity.ts: ProtocolSubcategory
      {
        name: 'protocol_subcategory_enum',
        values: [
          'modbus',
          'fieldbus',
          'ethernet_industrial',
          'plc_native',
          'plc',
          'building_automation',
          'realtime_ethernet',
          'message_queue',
          'request_response',
          'realtime',
          'wired_serial',
          'socket',
          'bus',
          'serial_port',
          'network',
          'lpwan',
          'mesh',
          'short_range',
        ],
      },
      // sensor-protocol.entity.ts: ConnectionType
      {
        name: 'connection_type_enum',
        values: [
          'tcp',
          'udp',
          'serial',
          'usb',
          'wireless',
          'hybrid',
          'ethernet',
          'i2c',
          'one_wire',
          'spi',
          'bluetooth',
        ],
      },
      // lora-device.entity.ts: LoRaActivationMode
      { name: 'lora_activation_mode_enum', values: ['OTAA', 'ABP'] },
      // lora-device.entity.ts: LoRaDeviceClass
      { name: 'lora_device_class_enum', values: ['A', 'B', 'C'] },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE "${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * sensor_protocols — sensor-protocol.entity.ts
   *
   * Reference-data table (listed in MODULE_SCHEMAS.referenceDataTables).
   * Created first because `sensors.protocol_id` FK targets this table.
   * `code` is unique. `simple-array` columns map to TEXT in Postgres
   * (TypeORM stores comma-separated values).
   */
  private async createSensorProtocolsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor_protocols" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(50) NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" varchar(255),
        "category" "protocol_category_enum" NOT NULL,
        "subcategory" "protocol_subcategory_enum",
        "connectionType" "connection_type_enum" NOT NULL,
        "configurationSchema" jsonb NOT NULL,
        "defaultConfiguration" jsonb,
        "documentationUrl" varchar,
        "iconName" varchar,
        "isActive" boolean NOT NULL DEFAULT true,
        "requiresGateway" boolean NOT NULL DEFAULT false,
        "gatewayProtocol" varchar,
        "supportsDiscovery" boolean NOT NULL DEFAULT false,
        "supportsBidirectional" boolean NOT NULL DEFAULT false,
        "supportsPolling" boolean NOT NULL DEFAULT true,
        "supportsSubscription" boolean NOT NULL DEFAULT false,
        "defaultPort" integer,
        "defaultBaudRate" integer,
        "defaultTimeout" integer,
        "maxConnectionsPerInstance" integer,
        "requiredPermissions" text,
        "supportedDataTypes" text,
        "sortOrder" integer,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sensor_protocols_code" UNIQUE ("code")
      );
      CREATE INDEX IF NOT EXISTS "IDX_sensor_protocols_code"
        ON "sensor_protocols" ("code");
      CREATE INDEX IF NOT EXISTS "IDX_sensor_protocols_category"
        ON "sensor_protocols" ("category");
      CREATE INDEX IF NOT EXISTS "IDX_sensor_protocols_isActive"
        ON "sensor_protocols" ("isActive");
    `);
  }

  /**
   * sensors — database/entities/sensor.entity.ts
   *
   * Apollo Federation owner of the `Sensor` type (see entity docblock).
   * `type_definition_id` column is intentionally OMITTED here —
   * `1740200000000-CreateDynamicSensorTypes` adds it conditional on
   * this table existing, which is exactly the seam this baseline
   * unblocks.
   *
   * FK to sensor_protocols (no onDelete — entity declares
   * `{ nullable: true }` only). Self-FK on parent_id with CASCADE per
   * entity decorator.
   */
  private async createSensorsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensors" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "serial_number" varchar NOT NULL,
        "type" "sensor_type_enum" NOT NULL,
        "manufacturer" varchar,
        "model" varchar,
        "firmware_version" varchar,
        "status" "sensor_status_enum" NOT NULL DEFAULT 'active',
        "tenant_id" uuid NOT NULL,
        "pond_id" varchar,
        "farm_id" varchar,
        "tank_id" varchar,
        "site_id" varchar,
        "department_id" varchar,
        "system_id" varchar,
        "equipment_id" varchar,
        "description" text,
        "location" varchar,
        "metadata" jsonb,
        "configuration" jsonb,
        "calibration_data" jsonb,
        "protocol_id" uuid,
        "protocol_configuration" jsonb,
        "connection_status" jsonb,
        "registration_status" "sensor_registration_status_enum" NOT NULL DEFAULT 'draft',
        "last_seen_at" timestamptz,
        "last_calibrated_at" timestamptz,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" varchar,
        "parent_id" uuid,
        "is_parent_device" boolean NOT NULL DEFAULT false,
        "data_path" varchar(255),
        "sensor_role" "sensor_role_enum",
        "unit" varchar,
        "min_value" numeric(15, 6),
        "max_value" numeric(15, 6),
        "calibration_enabled" boolean DEFAULT false,
        "calibration_multiplier" decimal(10, 6),
        "calibration_offset" decimal(10, 6),
        "alert_thresholds" jsonb,
        "display_settings" jsonb
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sensors_serial_number"
        ON "sensors" ("serial_number");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_status"
        ON "sensors" ("tenant_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_site"
        ON "sensors" ("tenant_id", "site_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_department"
        ON "sensors" ("tenant_id", "department_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_system"
        ON "sensors" ("tenant_id", "system_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_equipment"
        ON "sensors" ("tenant_id", "equipment_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_id"
        ON "sensors" ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_pond_id"
        ON "sensors" ("pond_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_tank_id"
        ON "sensors" ("tank_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_site_id"
        ON "sensors" ("site_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_department_id"
        ON "sensors" ("department_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_system_id"
        ON "sensors" ("system_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_equipment_id"
        ON "sensors" ("equipment_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_protocol_id"
        ON "sensors" ("protocol_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensors_parent_id"
        ON "sensors" ("parent_id");
    `);

    // FK to sensor_protocols.id (nullable — protocol assignment is
    // optional). No onDelete in entity → Postgres default NO ACTION.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sensors"
          ADD CONSTRAINT "FK_sensors_protocol"
          FOREIGN KEY ("protocol_id") REFERENCES "sensor_protocols"("id");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Self-FK on parent_id (CASCADE per entity).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sensors"
          ADD CONSTRAINT "FK_sensors_parent"
          FOREIGN KEY ("parent_id") REFERENCES "sensors"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * sensor_data_channels — database/entities/sensor-data-channel.entity.ts
   *
   * Per-channel metadata for multi-parameter sensors. The entity-level
   * `@Unique(['tenantId', 'sensorId', 'channelKey'])` is reproduced as a
   * UNIQUE constraint. FK to sensors (CASCADE).
   *
   * `1735900000000-CreateSensorMetrics` ALTERs this table to add
   * `unit_symbol`, `physical_min`, `physical_max`, `operational_min`,
   * `operational_max`, `next_calibration_due`, `calibration_polynomial`,
   * `protocol_config`. We include all of those columns in this baseline
   * so the ALTER becomes a no-op (the migration uses
   * `addColumnIfNotExists`). Mirroring matches the live entity shape.
   */
  private async createSensorDataChannelsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor_data_channels" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sensor_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "channel_key" varchar(100) NOT NULL,
        "display_label" varchar(200) NOT NULL,
        "description" text,
        "data_type" "channel_data_type_enum" NOT NULL DEFAULT 'number',
        "unit" varchar(50),
        "unit_symbol" varchar(10),
        "physical_min" numeric(15, 6),
        "physical_max" numeric(15, 6),
        "operational_min" numeric(15, 6),
        "operational_max" numeric(15, 6),
        "dataPath" varchar(255),
        "minValue" decimal(15, 6),
        "maxValue" decimal(15, 6),
        "calibration_enabled" boolean NOT NULL DEFAULT false,
        "calibration_multiplier" decimal(15, 6) NOT NULL DEFAULT 1.0,
        "calibration_offset" decimal(15, 6) NOT NULL DEFAULT 0.0,
        "lastCalibratedAt" timestamptz,
        "next_calibration_due" timestamptz,
        "calibration_polynomial" jsonb,
        "protocol_config" jsonb,
        "alertThresholds" jsonb,
        "displaySettings" jsonb,
        "discoveredAt" timestamptz,
        "discovery_source" "discovery_source_enum",
        "sampleValue" jsonb,
        "is_enabled" boolean NOT NULL DEFAULT true,
        "display_order" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sensor_data_channels_tenant_sensor_channel"
          UNIQUE ("tenant_id", "sensor_id", "channel_key")
      );
      CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_sensor_enabled"
        ON "sensor_data_channels" ("sensor_id", "is_enabled");
      CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_tenant_key"
        ON "sensor_data_channels" ("tenant_id", "channel_key");
      CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_sensor_id"
        ON "sensor_data_channels" ("sensor_id");
      CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_tenant_id"
        ON "sensor_data_channels" ("tenant_id");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sensor_data_channels"
          ADD CONSTRAINT "FK_sensor_data_channels_sensor"
          FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * dashboard_layouts — dashboard/entities/dashboard-layout.entity.ts
   *
   * No DB-level FKs. `process_background.processId` and
   * `widgets[].sensorIds` are captured inside JSONB columns and
   * resolved at the application layer (per the GridStack widget
   * architecture). Per-tenant by `tenant_id`.
   */
  private async createDashboardLayoutsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dashboard_layouts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "user_id" varchar,
        "name" varchar NOT NULL,
        "description" text,
        "widgets" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "process_background" jsonb,
        "grid_config" jsonb,
        "grid_version" integer NOT NULL DEFAULT 1,
        "is_default" boolean NOT NULL DEFAULT false,
        "is_system_default" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" varchar
      );
      CREATE INDEX IF NOT EXISTS "IDX_dashboard_layouts_tenant"
        ON "dashboard_layouts" ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_dashboard_layouts_tenant_user"
        ON "dashboard_layouts" ("tenant_id", "user_id");
      CREATE INDEX IF NOT EXISTS "IDX_dashboard_layouts_tenant_system_default"
        ON "dashboard_layouts" ("tenant_id", "is_system_default");
    `);
  }

  /**
   * device_groups — device-group/entities/device-group.entity.ts
   *
   * Self-referential parent_group_id (SET NULL on delete). Type column
   * is `varchar(50)` per entity (not enum) so a string default suffices.
   *
   * Compatible with `1741200000000-EnterprisePerformanceOptimizations`
   * which also creates this table `IF NOT EXISTS` — that migration
   * becomes a no-op for `device_groups` once this baseline runs first.
   */
  private async createDeviceGroupsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "device_groups" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "type" varchar(50) NOT NULL DEFAULT 'custom',
        "parent_group_id" uuid,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_device_groups_tenant"
        ON "device_groups" ("tenant_id");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "device_groups"
          ADD CONSTRAINT "FK_device_groups_parent"
          FOREIGN KEY ("parent_group_id") REFERENCES "device_groups"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * device_group_members — device-group/entities/device-group-member.entity.ts
   *
   * `@Unique(['groupId', 'deviceType', 'deviceId'])` on the entity is
   * reproduced as a UNIQUE constraint. FK to device_groups (CASCADE).
   * `device_type` is `varchar(50)` per entity (not enum).
   */
  private async createDeviceGroupMembersTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "device_group_members" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "group_id" uuid NOT NULL,
        "device_type" varchar(50) NOT NULL,
        "device_id" uuid NOT NULL,
        "added_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_device_group_members_group_type_device"
          UNIQUE ("group_id", "device_type", "device_id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_device_group_members_group_id"
        ON "device_group_members" ("group_id");
      CREATE INDEX IF NOT EXISTS "IDX_device_group_members_type_device"
        ON "device_group_members" ("device_type", "device_id");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "device_group_members"
          ADD CONSTRAINT "FK_device_group_members_group"
          FOREIGN KEY ("group_id") REFERENCES "device_groups"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * tenant_provisioning_keys — edge-device/entities/tenant-provisioning-key.entity.ts
   *
   * Self-registration token catalogue for edge-device onboarding.
   * No FKs — `default_site_id` is logically scoped per tenant but
   * intentionally unconstrained (sites table lives in farm-service's
   * schema, not sensor — cross-schema FKs are forbidden by ADR-011).
   */
  private async createTenantProvisioningKeysTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_provisioning_keys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "key_token" varchar(64) NOT NULL,
        "name" varchar(200),
        "is_active" boolean NOT NULL DEFAULT true,
        "max_devices" integer,
        "used_count" integer NOT NULL DEFAULT 0,
        "auto_approve" boolean NOT NULL DEFAULT false,
        "default_site_id" uuid,
        "expires_at" timestamptz,
        "created_by" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tenant_provisioning_keys_token" UNIQUE ("key_token")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_provisioning_keys_token"
        ON "tenant_provisioning_keys" ("key_token");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_provisioning_keys_tenant"
        ON "tenant_provisioning_keys" ("tenant_id");
    `);
  }

  /**
   * lora_devices — edge-device/entities/lora-device.entity.ts
   *
   * LoRaWAN end-devices attached to an EdgeDevice gateway. The FK
   * `edge_device_id → edge_devices(id)` is INTENTIONALLY split into
   * `1736800001000-AddLoraDevicesEdgeDeviceFk` because `edge_devices`
   * is created at 1736800000000 — after this baseline. Adding the FK
   * here would target a non-existent parent table.
   *
   * `app_key` column intentionally typed `varchar(255)` (not 16) — the
   * entity's `EncryptedColumnTransformer` stores AES-256-GCM ciphertext
   * in `enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>` format, which
   * exceeds the raw 16-byte LoRa AppKey size. UNIQUE on `dev_eui`.
   */
  private async createLoraDevicesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lora_devices" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "edge_device_id" varchar NOT NULL,
        "dev_eui" varchar(16) NOT NULL,
        "app_eui" varchar(16),
        "app_key" varchar(255) NOT NULL,
        "dev_addr" varchar(8),
        "activation_mode" "lora_activation_mode_enum" NOT NULL DEFAULT 'OTAA',
        "device_class" "lora_device_class_enum" NOT NULL DEFAULT 'A',
        "name" varchar(50) NOT NULL,
        "tag_prefix" varchar(30) NOT NULL,
        "codec" varchar(20) NOT NULL DEFAULT 'cayenne_lpp',
        "adr_enabled" boolean NOT NULL DEFAULT true,
        "f_port" smallint NOT NULL DEFAULT 1,
        "last_seen_at" timestamptz,
        "last_rssi" real,
        "last_snr" real,
        "frame_count_up" integer,
        "is_joined" boolean NOT NULL DEFAULT false,
        "joined_at" timestamptz,
        "tenant_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_lora_devices_dev_eui" UNIQUE ("dev_eui")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_lora_devices_dev_eui"
        ON "lora_devices" ("dev_eui");
      CREATE INDEX IF NOT EXISTS "IDX_lora_devices_tenant_edge"
        ON "lora_devices" ("tenant_id", "edge_device_id");
    `);
  }
}
