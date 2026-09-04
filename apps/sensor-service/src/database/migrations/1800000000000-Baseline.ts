import { MigrationInterface, QueryRunner } from "typeorm";

import { applyTenantRlsToSchema, removeTenantRlsFromSchema } from '@aquaculture/backend-common/database'; // Faz 3.5 RLS additions: import block
export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensor_protocols_category_enum" AS ENUM('industrial', 'iot', 'serial', 'wireless'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensor_protocols_subcategory_enum" AS ENUM('modbus', 'fieldbus', 'ethernet_industrial', 'plc_native', 'plc', 'building_automation', 'realtime_ethernet', 'message_queue', 'request_response', 'realtime', 'wired_serial', 'socket', 'bus', 'serial_port', 'network', 'lpwan', 'mesh', 'short_range'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensor_protocols_connectiontype_enum" AS ENUM('tcp', 'udp', 'serial', 'usb', 'wireless', 'hybrid', 'ethernet', 'i2c', 'one_wire', 'spi', 'bluetooth'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor_protocols" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(50) NOT NULL, "name" character varying(100) NOT NULL, "description" character varying(255), "category" "sensor"."sensor_protocols_category_enum" NOT NULL, "subcategory" "sensor"."sensor_protocols_subcategory_enum", "connectionType" "sensor"."sensor_protocols_connectiontype_enum" NOT NULL, "configurationSchema" jsonb NOT NULL, "defaultConfiguration" jsonb, "documentationUrl" character varying, "iconName" character varying, "isActive" boolean NOT NULL DEFAULT true, "requiresGateway" boolean NOT NULL DEFAULT false, "gatewayProtocol" character varying, "supportsDiscovery" boolean NOT NULL DEFAULT false, "supportsBidirectional" boolean NOT NULL DEFAULT false, "supportsPolling" boolean NOT NULL DEFAULT true, "supportsSubscription" boolean NOT NULL DEFAULT false, "defaultPort" integer, "defaultBaudRate" integer, "defaultTimeout" integer, "maxConnectionsPerInstance" integer, "requiredPermissions" text, "supportedDataTypes" text, "sortOrder" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_458edeec38b72795b233f07ff5f" UNIQUE ("code"), CONSTRAINT "PK_8d50d0f22d56e2873e8d32a55fb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c7cb37ac08d5ba271f84ac0fe9" ON "sensor_protocols" ("isActive") `);
        await queryRunner.query(`CREATE INDEX "IDX_90ad882ddf58a754837c834b02" ON "sensor_protocols" ("category") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_458edeec38b72795b233f07ff5" ON "sensor_protocols" ("code") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor_type_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "type_key" character varying(100) NOT NULL, "display_name" character varying(200) NOT NULL, "description" text, "icon" character varying(100), "category" character varying(100), "industry" character varying(100), "is_system" boolean NOT NULL DEFAULT false, "default_channels" jsonb NOT NULL DEFAULT '[]', "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_acadb72351e9ab5fe2577b32cdf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4806b50944810eb8471733f1b0" ON "sensor_type_definitions" ("tenant_id", "type_key") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor"."sensor_audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "entity_type" character varying(100) NOT NULL, "entity_id" uuid NOT NULL, "action" character varying(20) NOT NULL, "previous_value" jsonb, "new_value" jsonb, "changed_fields" jsonb, "changed_by" uuid, "changed_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_57d140b044c04803f6ac63477d4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_d4f984848932af43f8aaaebc32" ON "sensor"."sensor_audit_logs" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_591c741761e2a3037dedf9d3a3" ON "sensor"."sensor_audit_logs" ("tenant_id", "changed_at") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_640549f962a7279884081bfe1e" ON "sensor"."sensor_audit_logs" ("tenant_id", "entity_type", "entity_id") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensors_type_enum" AS ENUM('temperature', 'ph', 'dissolved_oxygen', 'salinity', 'ammonia', 'nitrite', 'nitrate', 'turbidity', 'water_level', 'multi_parameter', 'flow_rate', 'conductivity', 'orp', 'chlorine', 'co2'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensors_status_enum" AS ENUM('active', 'inactive', 'maintenance', 'error', 'offline'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensors_registration_status_enum" AS ENUM('draft', 'pending_test', 'testing', 'test_failed', 'active', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensors_sensor_role_enum" AS ENUM('parent', 'child'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "serial_number" character varying NOT NULL, "type" "sensor"."sensors_type_enum" NOT NULL, "manufacturer" character varying, "model" character varying, "firmware_version" character varying, "status" "sensor"."sensors_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid NOT NULL, "pond_id" character varying, "farm_id" character varying, "tank_id" character varying, "site_id" character varying, "department_id" character varying, "system_id" character varying, "equipment_id" character varying, "description" text, "location" character varying, "metadata" jsonb, "configuration" jsonb, "calibration_data" jsonb, "protocol_id" uuid, "protocol_configuration" jsonb, "connection_status" jsonb, "type_definition_id" uuid, "registration_status" "sensor"."sensors_registration_status_enum" NOT NULL DEFAULT 'draft', "last_seen_at" TIMESTAMP WITH TIME ZONE, "last_calibrated_at" TIMESTAMP WITH TIME ZONE, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, "parent_id" uuid, "is_parent_device" boolean NOT NULL DEFAULT false, "data_path" character varying(255), "sensor_role" "sensor"."sensors_sensor_role_enum", "unit" character varying, "min_value" numeric(15,6), "max_value" numeric(15,6), "calibration_enabled" boolean NOT NULL DEFAULT false, "calibration_multiplier" numeric(10,6), "calibration_offset" numeric(10,6), "alert_thresholds" jsonb, "display_settings" jsonb, CONSTRAINT "PK_b8bd5fcfd700e39e96bcd9ba6b7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fd691555a1970ea5fbadd3e2b4" ON "sensors" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_59b028bdc5d22fcfa1e8904943" ON "sensors" ("pond_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ea42ff64e4f254995112843ac9" ON "sensors" ("tank_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8021d035f80450c85300e62d29" ON "sensors" ("site_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e435eecf5b38444c7d6352a95c" ON "sensors" ("department_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ff1a805621c439ebd7bae48048" ON "sensors" ("system_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7213900c3ed0bc3d42bc28cd54" ON "sensors" ("equipment_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_662ff86473e2a4fbc892c3463b" ON "sensors" ("protocol_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c9c45d8d0283ebee985bd7658" ON "sensors" ("parent_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3825b39a36779086c0b33d8336" ON "sensors" ("tenant_id", "equipment_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3f299085726ca10771b3e6a8c5" ON "sensors" ("tenant_id", "system_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c93462be0545df6b48615dbddf" ON "sensors" ("tenant_id", "department_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0f886866b8ffc4d4a9bce2ad15" ON "sensors" ("tenant_id", "site_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_sensors_serial_number" ON "sensors" ("serial_number") `);
        await queryRunner.query(`CREATE INDEX "IDX_0565c3267d3cb4204a1757c1b7" ON "sensors" ("tenant_id", "status") `);
        // PK is composite (id, timestamp) — TimescaleDB hypertable contract
        // requires the partition column ("timestamp") to be in every
        // UNIQUE INDEX on the table. The entity at
        // apps/sensor-service/src/database/entities/sensor-reading.entity.ts
        // mirrors this composite PK via two @PrimaryColumn decorators.
        // See the entity docblock for the federation + query-by-id rationale.
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor"."sensor_readings" ("id" uuid NOT NULL, "sensor_id" character varying NOT NULL, "tenant_id" uuid NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "readings" jsonb NOT NULL, "pond_id" character varying, "farm_id" character varying, "quality" numeric(10,2), "source" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ae97fcc8df9e5662d9d007d102b" PRIMARY KEY ("id", "timestamp"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_d1df5a824e4467f5a645d7b362" ON "sensor"."sensor_readings" ("sensor_id") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_9417244ed127d5ef9f2b46750a" ON "sensor"."sensor_readings" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_09d7dd109cd8f0f1a59aaac78a" ON "sensor"."sensor_readings" ("timestamp") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ce4ad1c5885cf09dc41939fda6" ON "sensor"."sensor_readings" ("pond_id", "timestamp") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_79b6ae4cba75c33361355806d1" ON "sensor"."sensor_readings" ("tenant_id", "timestamp") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_0376e08a5128b463a79a811084" ON "sensor"."sensor_readings" ("sensor_id", "timestamp") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensor_data_channels_data_type_enum" AS ENUM('number', 'boolean', 'string', 'enum'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."sensor_data_channels_discovery_source_enum" AS ENUM('auto', 'manual', 'template'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor_data_channels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sensor_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "channel_key" character varying(100) NOT NULL, "display_label" character varying(200) NOT NULL, "description" text, "data_type" "sensor"."sensor_data_channels_data_type_enum" NOT NULL DEFAULT 'number', "unit" character varying(50), "unit_symbol" character varying(10), "physical_min" numeric(15,6), "physical_max" numeric(15,6), "operational_min" numeric(15,6), "operational_max" numeric(15,6), "dataPath" character varying(255), "minValue" numeric(15,6), "maxValue" numeric(15,6), "calibration_enabled" boolean NOT NULL DEFAULT false, "calibration_multiplier" numeric(15,6) NOT NULL DEFAULT '1', "calibration_offset" numeric(15,6) NOT NULL DEFAULT '0', "lastCalibratedAt" TIMESTAMP WITH TIME ZONE, "next_calibration_due" TIMESTAMP WITH TIME ZONE, "calibration_polynomial" jsonb, "protocol_config" jsonb, "alertThresholds" jsonb, "displaySettings" jsonb, "discoveredAt" TIMESTAMP WITH TIME ZONE, "discovery_source" "sensor"."sensor_data_channels_discovery_source_enum", "sampleValue" jsonb, "is_enabled" boolean NOT NULL DEFAULT true, "display_order" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_92bb07636d8d6cde0ce83124f77" UNIQUE ("tenant_id", "sensor_id", "channel_key"), CONSTRAINT "PK_09b366b60609e416f6e35fd9258" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fe6f0c27169af47a4371c0efeb" ON "sensor_data_channels" ("sensor_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_902eb2436271895c7a853da52f" ON "sensor_data_channels" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_39626616a2d8ed5cbb2c819e00" ON "sensor_data_channels" ("tenant_id", "channel_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_28f8895a1f2731b3fdda60b64b" ON "sensor_data_channels" ("sensor_id", "is_enabled") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor_metrics" ("time" TIMESTAMP WITH TIME ZONE NOT NULL, "sensor_id" uuid NOT NULL, "channel_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "site_id" uuid, "department_id" uuid, "system_id" uuid, "equipment_id" uuid, "tank_id" uuid, "pond_id" uuid, "farm_id" uuid, "raw_value" double precision NOT NULL, "value" double precision NOT NULL, "quality_code" smallint NOT NULL DEFAULT '192', "quality_bits" smallint NOT NULL DEFAULT '0', "source_protocol" character varying(20), "source_timestamp" TIMESTAMP WITH TIME ZONE, "ingestion_latency_ms" integer, "batch_id" uuid, CONSTRAINT "PK_84db706dfb0f7caaf345e2ec4ed" PRIMARY KEY ("time", "sensor_id", "channel_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f8ed794f2cdefbadbbd14f7368" ON "sensor_metrics" ("equipment_id", "time") `);
        await queryRunner.query(`CREATE INDEX "IDX_411b104d2bcf2c83d09b806bb8" ON "sensor_metrics" ("tank_id", "time") `);
        await queryRunner.query(`CREATE INDEX "IDX_820e5dc30e11a2a47b5358868d" ON "sensor_metrics" ("tenant_id", "time") `);
        await queryRunner.query(`CREATE INDEX "IDX_d528fb7f99fae26f611eadc7b3" ON "sensor_metrics" ("channel_id", "time") `);
        await queryRunner.query(`CREATE INDEX "IDX_ac69ebd076edf1a5978722747d" ON "sensor_metrics" ("sensor_id", "time") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "channel_detection_log" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "sensor_id" uuid NOT NULL, "raw_sample" jsonb NOT NULL, "ai_analysis" jsonb NOT NULL, "proposed_channels" jsonb NOT NULL, "user_action" character varying(20), "final_channels" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c04c0bf33eefc19efd33168ba40" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6f62be38cd349f88bb30ed5759" ON "channel_detection_log" ("sensor_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ebc92a57969fe6c5ca27da4ae6" ON "channel_detection_log" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "industry_templates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "template_key" character varying(100) NOT NULL, "display_name" character varying(200) NOT NULL, "description" text, "icon" character varying(100), "sensor_types" jsonb NOT NULL DEFAULT '[]', "dashboard_layout" jsonb, "alert_presets" jsonb, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_990a9740ab0062921e6caaa74f0" UNIQUE ("template_key"), CONSTRAINT "PK_8a0891ba1a0b1f47e921a859d13" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_parameter_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid, "brand" character varying(50) NOT NULL, "model_series" character varying(100), "parameter_name" character varying(100) NOT NULL, "display_name" character varying(255) NOT NULL, "description" text, "category" character varying(50) NOT NULL DEFAULT 'configuration', "group" character varying(50) NOT NULL, "register_address" integer NOT NULL, "register_count" integer NOT NULL DEFAULT '1', "function_code" integer NOT NULL DEFAULT '6', "data_type" character varying(50) NOT NULL DEFAULT 'uint16', "scaling_factor" double precision NOT NULL DEFAULT '1', "offset" double precision NOT NULL DEFAULT '0', "unit" character varying(20), "byte_order" character varying(10) NOT NULL DEFAULT 'big', "word_order" character varying(10) NOT NULL DEFAULT 'big', "min_value" double precision, "max_value" double precision, "default_value" double precision, "step" double precision, "risk_level" character varying(20) NOT NULL DEFAULT 'medium', "requires_motor_stop" boolean NOT NULL DEFAULT false, "is_readable" boolean NOT NULL DEFAULT true, "is_writable" boolean NOT NULL DEFAULT true, "is_active" boolean NOT NULL DEFAULT true, "display_order" integer NOT NULL DEFAULT '0', "metadata" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_3e3a3ea4ea30b09011169caf965" UNIQUE ("brand", "model_series", "parameter_name"), CONSTRAINT "PK_278c8c6dfe7a31a5d072b29e26f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bbe01ccebc458c038d4e052286" ON "vfd_parameter_definitions" ("brand", "group") `);
        await queryRunner.query(`CREATE INDEX "IDX_c1869c159ad03f8fdedd9825c2" ON "vfd_parameter_definitions" ("brand") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_parameter_audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "vfd_device_id" uuid NOT NULL, "change_set_id" uuid, "parameter_name" character varying(100) NOT NULL, "previous_value" numeric(15,6), "new_value" numeric(15,6) NOT NULL, "action" character varying(30) NOT NULL, "performed_by" character varying(255) NOT NULL, "client_ip" character varying(45), "user_agent" character varying(500), "automation_rule_id" uuid, "metadata" jsonb, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a30dbeeb67addb9cd9419e2bc83" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bc85ed7a1260e3464f9d6d32df" ON "vfd_parameter_audit_logs" ("change_set_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_71e3e037cb99567da9443707a2" ON "vfd_parameter_audit_logs" ("tenant_id", "vfd_device_id", "timestamp") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_change_set_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "change_set_id" uuid NOT NULL, "parameter_definition_id" uuid NOT NULL, "parameter_name" character varying(100) NOT NULL, "previous_value" numeric(15,6), "requested_value" numeric(15,6) NOT NULL, "applied_value" numeric(15,6), "status" character varying(20) NOT NULL DEFAULT 'pending', "error_message" text, "applied_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cef604a29c85fcc3c1affa33265" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8d7b4c9c9f012299a04dd4f980" ON "vfd_change_set_items" ("change_set_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_change_sets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "vfd_device_id" uuid NOT NULL, "status" character varying(30) NOT NULL DEFAULT 'draft', "description" text NOT NULL, "created_by" uuid NOT NULL, "approved_by" uuid, "rejected_by" uuid, "rejection_reason" text, "applied_at" TIMESTAMP WITH TIME ZONE, "verified_at" TIMESTAMP WITH TIME ZONE, "scheduled_at" TIMESTAMP WITH TIME ZONE, "automation_rule_id" uuid, "rollback_of_id" uuid, "metadata" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ee995d971f81afa804fef65ece4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fc0920cc636dcb8c07781008ae" ON "vfd_change_sets" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_271cddf4c36660be270d80cd37" ON "vfd_change_sets" ("tenant_id", "vfd_device_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "sensor"."vfd_register_mappings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "brand" character varying(50) NOT NULL, "model_series" character varying(100), "parameter_name" character varying(100) NOT NULL, "display_name" character varying(255) NOT NULL, "description" text, "category" character varying(50) NOT NULL, "registerAddress" integer NOT NULL, "register_count" integer NOT NULL DEFAULT '1', "function_code" integer NOT NULL DEFAULT '3', "data_type" character varying(50) NOT NULL DEFAULT 'uint16', "scaling_factor" numeric(15,6) NOT NULL DEFAULT '1', "offset" numeric(15,6) NOT NULL DEFAULT '0', "unit" character varying(20), "byte_order" character varying(10) NOT NULL DEFAULT 'big', "word_order" character varying(10) NOT NULL DEFAULT 'big', "is_bit_field" boolean NOT NULL DEFAULT false, "bit_definitions" jsonb, "is_readable" boolean NOT NULL DEFAULT true, "is_writable" boolean NOT NULL DEFAULT false, "recommended_poll_interval_ms" integer NOT NULL DEFAULT '500', "display_order" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "is_critical" boolean NOT NULL DEFAULT false, "min_value" numeric(15,6), "max_value" numeric(15,6), "metadata" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_8d5c72af00b61d8bdde93552bb5" UNIQUE ("brand", "model_series", "parameter_name"), CONSTRAINT "PK_ead0e16d0cb4f5248a0f3280ab8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_277fb0384f12ff475407283d22" ON "sensor"."vfd_register_mappings" ("category") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_28e3f61e6e4831f6367fd3c42e" ON "sensor"."vfd_register_mappings" ("brand", "parameter_name") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_a684c060f0c5755d75d6a89dfd" ON "sensor"."vfd_register_mappings" ("brand", "model_series") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_e57231f95c307cb75b326af633" ON "sensor"."vfd_register_mappings" ("brand") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "brand" character varying(50) NOT NULL, "model" character varying(100), "serialNumber" character varying(100), "protocol" character varying(50) NOT NULL, "protocolConfiguration" jsonb NOT NULL, "connectionStatus" jsonb, "status" character varying(50) NOT NULL DEFAULT 'draft', "tenant_id" uuid NOT NULL, "farm_id" uuid, "tank_id" uuid, "location" character varying(255), "description" text, "metadata" jsonb, "customRegisterMappings" jsonb, "poll_interval_ms" integer NOT NULL DEFAULT '1000', "is_polling_enabled" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdBy" uuid, "updatedBy" uuid, CONSTRAINT "PK_239c339df58f66b245d824ee4d7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8dbec8dad1775903e3f6eb9db1" ON "vfd_devices" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d98c50eadb87a3ca53bd0674b3" ON "vfd_devices" ("tenant_id", "protocol") `);
        await queryRunner.query(`CREATE INDEX "IDX_e58e1334f05fe59384924706d6" ON "vfd_devices" ("tenant_id", "brand") `);
        await queryRunner.query(`CREATE INDEX "IDX_5753ebcc5ddbdd2a73b2c5d8b9" ON "vfd_devices" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_readings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vfd_device_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "parameters" jsonb NOT NULL, "statusBits" jsonb, "rawValues" jsonb, "latencyMs" integer, "isValid" boolean NOT NULL DEFAULT true, "errorMessage" character varying(255), "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_02e4a20e21ff6e9dd21cf0a747e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fbdeb2c3e706814795870612d1" ON "vfd_readings" ("vfd_device_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0559dc2a76d3f69400def2281d" ON "vfd_readings" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6f2fe4f58bed066b6f1e77ef19" ON "vfd_readings" ("timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_f1854b90eea1d29d7abdf5ff26" ON "vfd_readings" ("tenant_id", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_ce291c730d3e027c512b029fa3" ON "vfd_readings" ("vfd_device_id", "timestamp") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."unified_tags_io_type_enum" AS ENUM('DI', 'DO', 'AI', 'AO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."unified_tags_data_type_enum" AS ENUM('BOOL', 'INT16', 'INT32', 'UINT16', 'UINT32', 'FLOAT32', 'FLOAT64'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."unified_tags_direction_enum" AS ENUM('input', 'output', 'bidirectional'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "unified_tags" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "fqn" character varying(500) NOT NULL, "local_name" character varying(100) NOT NULL, "display_name" character varying, "description" text, "io_type" "sensor"."unified_tags_io_type_enum" NOT NULL, "data_type" "sensor"."unified_tags_data_type_enum" NOT NULL, "direction" "sensor"."unified_tags_direction_enum" NOT NULL DEFAULT 'input', "eng_unit" character varying(20), "eng_min" numeric(15,6), "eng_max" numeric(15,6), "alarm_hh" numeric(15,6), "alarm_h" numeric(15,6), "alarm_l" numeric(15,6), "alarm_ll" numeric(15,6), "deadband" numeric(15,6), "source" jsonb NOT NULL DEFAULT '{}', "hierarchy" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6c2c6126e7d89083d4bc19b1060" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7aafbe6e48afee69e377bfc96b" ON "unified_tags" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_31a1a988d2dca6be2b4387a10b" ON "unified_tags" ("tenant_id", "fqn") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."scada_packages_status_enum" AS ENUM('draft', 'published', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "scada_packages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "name" character varying NOT NULL, "description" text, "version" integer NOT NULL DEFAULT '1', "process_id" uuid, "package_data" jsonb NOT NULL DEFAULT '{}', "status" "sensor"."scada_packages_status_enum" NOT NULL DEFAULT 'draft', "created_by" character varying, "updated_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_41050c4e13a93d324106de77187" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_04afe40713d67d6d2949649a19" ON "scada_packages" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a6d9f66fb4bea82e1e5e20d453" ON "scada_packages" ("tenant_id", "status") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."scada_deploy_logs_status_enum" AS ENUM('pending', 'sent', 'received', 'deploying', 'verifying', 'success', 'failed', 'rolled_back'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "scada_deploy_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "package_id" uuid NOT NULL, "device_id" uuid NOT NULL, "command_id" uuid NOT NULL, "version" integer NOT NULL, "status" "sensor"."scada_deploy_logs_status_enum" NOT NULL DEFAULT 'pending', "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "received_at" TIMESTAMP WITH TIME ZONE, "deployed_at" TIMESTAMP WITH TIME ZONE, "verified_at" TIMESTAMP WITH TIME ZONE, "health_check_results" jsonb, "error_message" text, "rolled_back_to" integer, "deployed_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_477f1cbe56985e4021cef6466b9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b381db4a8e08c550780dcbff61" ON "scada_deploy_logs" ("tenant_id", "command_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fb3cfe123943e43090f92af6e3" ON "scada_deploy_logs" ("tenant_id", "package_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4a66dae20855f80b3df131642f" ON "scada_deploy_logs" ("tenant_id", "device_id") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."processes_status_enum" AS ENUM('draft', 'active', 'inactive', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "processes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "code" character varying NOT NULL, "description" text, "status" "sensor"."processes_status_enum" NOT NULL DEFAULT 'draft', "nodes" jsonb NOT NULL DEFAULT '[]', "edges" jsonb NOT NULL DEFAULT '[]', "tenant_id" uuid NOT NULL, "site_id" character varying, "department_id" character varying, "metadata" jsonb, "is_template" boolean NOT NULL DEFAULT false, "template_name" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, "updated_by" character varying, CONSTRAINT "PK_566885de50f7d20a6df306c12e6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0dad5402604429197412690a76" ON "processes" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_41eb2461c733df4d36f56375a7" ON "processes" ("site_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_59a27fec5591df8bedf39e892b" ON "processes" ("tenant_id", "site_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6e41e1a73e5b33b051e58ec2e1" ON "processes" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "plc_telemetry" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "plcConnectionId" character varying NOT NULL, "tankId" character varying, "timestamp" TIMESTAMP NOT NULL, "sensors" jsonb NOT NULL, "actuators" jsonb NOT NULL, "feeding" jsonb NOT NULL, "plcStatus" jsonb NOT NULL, "activeParameterId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e26d034dad38c3e295555da0636" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_28066c3a557ad6a5b72ace20b0" ON "plc_telemetry" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d3960cbf31cf63d54248e760f8" ON "plc_telemetry" ("timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_02a56317521fe5f1901b66f4ed" ON "plc_telemetry" ("tenant_id", "plcConnectionId", "timestamp") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "plc_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "siteId" character varying NOT NULL, "tankId" character varying, "name" character varying NOT NULL, "description" character varying, "endpointUrl" character varying NOT NULL, "securityMode" character varying NOT NULL DEFAULT 'None', "securityPolicy" character varying DEFAULT 'None', "authMode" character varying NOT NULL DEFAULT 'Anonymous', "username" character varying, "password" text, "clientCertificate" text, "clientPrivateKey" text, "serverCertificate" text, "status" character varying NOT NULL DEFAULT 'OFFLINE', "lastConnectedAt" TIMESTAMP, "lastError" character varying, "publishingIntervalMs" integer NOT NULL DEFAULT '1000', "samplingIntervalMs" integer NOT NULL DEFAULT '500', "sessionTimeoutMs" integer NOT NULL DEFAULT '60000', "connectTimeoutMs" integer NOT NULL DEFAULT '5000', "requestTimeoutMs" integer NOT NULL DEFAULT '60000', "autoReconnect" boolean NOT NULL DEFAULT true, "maxReconnectAttempts" integer NOT NULL DEFAULT '-1', "reconnectDelayMs" integer NOT NULL DEFAULT '1000', "maxReconnectDelayMs" integer NOT NULL DEFAULT '30000', "keepAliveIntervalMs" integer NOT NULL DEFAULT '5000', "failoverEndpointUrl" character varying, "parametersNodeId" character varying, "telemetryNodeId" character varying, "alarmsNodeId" character varying, "statusNodeId" character varying, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0bb8d4fb40d728e857ed9fbf9fe" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e4c1a8a0110af5f90766c20fce" ON "plc_connections" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_37a6b9524cdc966ddc53292b44" ON "plc_connections" ("tenant_id", "siteId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "plc_alarms" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "plcConnectionId" character varying NOT NULL, "tankId" character varying, "alarmCode" character varying NOT NULL, "severity" character varying NOT NULL, "source" character varying NOT NULL, "message" character varying NOT NULL, "value" numeric(10,4), "threshold" numeric(10,4), "action" character varying, "timestamp" TIMESTAMP NOT NULL, "acknowledged" boolean NOT NULL DEFAULT false, "acknowledgedAt" TIMESTAMP, "acknowledgedBy" character varying, "clearedAt" TIMESTAMP, "notes" character varying, "approval_level" integer NOT NULL DEFAULT '0', "required_approval_level" integer NOT NULL DEFAULT '1', "approval_chain" jsonb NOT NULL DEFAULT '[]', "escalated_at" TIMESTAMP WITH TIME ZONE, "auto_escalate_after_ms" integer, "sla_deadline" TIMESTAMP WITH TIME ZONE, "sla_breached" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f342b65890850b57364229fd6b3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_68df53f42ed34d1383a0a32228" ON "plc_alarms" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9c01d78a4e5aab2d32f8fb5130" ON "plc_alarms" ("timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_b09dd93b839527c06fab1d1868" ON "plc_alarms" ("tenant_id", "acknowledged") `);
        await queryRunner.query(`CREATE INDEX "IDX_790af4ecae00bf341562600c40" ON "plc_alarms" ("tenant_id", "plcConnectionId", "timestamp") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "feeding_parameters" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "plcConnectionId" uuid NOT NULL, "tankId" character varying, "name" character varying NOT NULL, "description" character varying, "version" character varying NOT NULL DEFAULT '1.0', "biomassKg" numeric(10,2) NOT NULL, "fcr" numeric(5,3) NOT NULL, "targetDailyFeedKg" numeric(10,2) NOT NULL, "schedule" jsonb NOT NULL, "thresholds" jsonb NOT NULL, "vfdSettings" jsonb NOT NULL, "status" character varying NOT NULL DEFAULT 'DRAFT', "sentAt" TIMESTAMP, "acknowledgedAt" TIMESTAMP, "activatedAt" character varying, "errorMessage" text, "checksum" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "createdBy" character varying, CONSTRAINT "PK_98989aded5834effa314e4728de" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1ea3e2254e107b1caff65564f9" ON "feeding_parameters" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2249a91eb2ce78f6b55de6ca66" ON "feeding_parameters" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_d2e123cdb64f6ed10965baee94" ON "feeding_parameters" ("tenant_id", "plcConnectionId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "tenant_provisioning_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "key_token" character varying(64) NOT NULL, "name" character varying(200), "is_active" boolean NOT NULL DEFAULT true, "max_devices" integer, "used_count" integer NOT NULL DEFAULT '0', "auto_approve" boolean NOT NULL DEFAULT false, "default_site_id" uuid, "expires_at" TIMESTAMP WITH TIME ZONE, "created_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_16fc3fc7e0e4e8023bc5ea9d347" UNIQUE ("key_token"), CONSTRAINT "PK_ae41a7828996ce0a414ff99dfcb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_445c3ed7df2859c8d59d1b6408" ON "tenant_provisioning_keys" ("tenant_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_16fc3fc7e0e4e8023bc5ea9d34" ON "tenant_provisioning_keys" ("key_token") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."edge_devices_device_model_enum" AS ENUM('revolution_pi_connect_4', 'revolution_pi_compact', 'raspberry_pi_4', 'raspberry_pi_5', 'raspberry_pi_4_lora', 'raspberry_pi_5_lora', 'industrial_pc', 'custom'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."edge_devices_lifecycle_state_enum" AS ENUM('registered', 'provisioning', 'pending_approval', 'active', 'offline', 'maintenance', 'error', 'revoked', 'decommissioned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "edge_devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "site_id" character varying, "device_code" character varying(50) NOT NULL, "device_name" character varying(100) NOT NULL, "device_model" "sensor"."edge_devices_device_model_enum" NOT NULL, "serial_number" character varying(100), "description" text, "lifecycle_state" "sensor"."edge_devices_lifecycle_state_enum" NOT NULL DEFAULT 'registered', "commissioned_at" TIMESTAMP WITH TIME ZONE, "commissioned_by" character varying, "mqtt_client_id" character varying(100), "certificate_thumbprint" character varying(64), "certificate_expires_at" TIMESTAMP WITH TIME ZONE, "security_level" integer NOT NULL DEFAULT '2', "provisioning_token" character varying(64), "token_expires_at" TIMESTAMP WITH TIME ZONE, "token_used_at" TIMESTAMP WITH TIME ZONE, "mqtt_password_hash" character varying(128), "fingerprint" jsonb, "agent_version" character varying(30), "last_seen_at" TIMESTAMP WITH TIME ZONE, "is_online" boolean NOT NULL DEFAULT false, "connection_quality" integer, "ip_address" inet, "firmware_version" character varying(30), "firmware_updated_at" TIMESTAMP WITH TIME ZONE, "target_firmware_version" character varying(30), "cpu_usage" integer, "memory_usage" integer, "storage_usage" integer, "temperature_celsius" numeric(5,2), "uptime_seconds" bigint, "timezone" character varying(50) NOT NULL DEFAULT 'UTC', "scan_rate_ms" integer NOT NULL DEFAULT '100', "config" jsonb, "capabilities" jsonb, "tags" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, CONSTRAINT "PK_a4f0c098c570b229b056155b557" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_efe55fa5f6a895eb9edfb81d5a" ON "edge_devices" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d2e2cfe76509f8a5b41740c39d" ON "edge_devices" ("site_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_edge_devices_serial_number" ON "edge_devices" ("serial_number") WHERE serial_number IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_75736011e0fb0cd817ca612a2a" ON "edge_devices" ("mqtt_client_id") WHERE mqtt_client_id IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6647fe3f99b17d234896ae0933" ON "edge_devices" ("device_code") `);
        await queryRunner.query(`CREATE INDEX "IDX_242731453afdc96bf3e827f90d" ON "edge_devices" ("tenant_id", "site_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4e8f558f533ae811b65ec7c75d" ON "edge_devices" ("tenant_id", "lifecycle_state") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."lora_devices_activation_mode_enum" AS ENUM('OTAA', 'ABP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."lora_devices_device_class_enum" AS ENUM('A', 'B', 'C'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "lora_devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "edge_device_id" uuid NOT NULL, "dev_eui" character varying(16) NOT NULL, "app_eui" character varying(16), "app_key" character varying(255) NOT NULL, "dev_addr" character varying(8), "activation_mode" "sensor"."lora_devices_activation_mode_enum" NOT NULL DEFAULT 'OTAA', "device_class" "sensor"."lora_devices_device_class_enum" NOT NULL DEFAULT 'A', "name" character varying(50) NOT NULL, "tag_prefix" character varying(30) NOT NULL, "codec" character varying(20) NOT NULL DEFAULT 'cayenne_lpp', "adr_enabled" boolean NOT NULL DEFAULT true, "f_port" smallint NOT NULL DEFAULT '1', "last_seen_at" TIMESTAMP WITH TIME ZONE, "last_rssi" real, "last_snr" real, "frame_count_up" integer, "is_joined" boolean NOT NULL DEFAULT false, "joined_at" TIMESTAMP WITH TIME ZONE, "tenant_id" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_621ce9c7d8b02f1f37708f809e8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6906bb3449ae2bab2fb224500d" ON "lora_devices" ("dev_eui") `);
        await queryRunner.query(`CREATE INDEX "IDX_9dab81dea827e9c031b120ee44" ON "lora_devices" ("tenant_id", "edge_device_id") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."device_io_configs_io_type_enum" AS ENUM('DI', 'DO', 'AI', 'AO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."device_io_configs_data_type_enum" AS ENUM('bool', 'int16', 'int32', 'uint16', 'uint32', 'float32', 'float64'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "device_io_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "device_id" uuid NOT NULL, "tag_name" character varying(50) NOT NULL, "description" character varying(200), "io_type" "sensor"."device_io_configs_io_type_enum" NOT NULL, "data_type" "sensor"."device_io_configs_data_type_enum" NOT NULL, "module_address" integer NOT NULL, "channel" integer NOT NULL, "raw_min" numeric(15,4), "raw_max" numeric(15,4), "eng_min" numeric(15,4), "eng_max" numeric(15,4), "eng_unit" character varying(20), "modbus_function" integer, "modbus_slave_id" integer NOT NULL DEFAULT '1', "modbus_register" integer, "gpio_pin" integer, "gpio_mode" character varying(20), "bus_type" character varying(10), "i2c_bus" smallint, "i2c_address" smallint, "spi_bus" smallint, "spi_cs" smallint, "uart_port" character varying(50), "driver_type" character varying(50), "invert_value" boolean NOT NULL DEFAULT false, "alarm_hh" numeric(15,4), "alarm_h" numeric(15,4), "alarm_l" numeric(15,4), "alarm_ll" numeric(15,4), "deadband" numeric(15,4), "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a063ab1a846580af546c182d070" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7729fd7b2767fe51ca19628090" ON "device_io_configs" ("device_id", "module_address", "channel") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_09bffbc3f2febc9f589aff6614" ON "device_io_configs" ("device_id", "tag_name") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."device_events_event_type_enum" AS ENUM('self_registered', 'approved', 'connected', 'disconnected', 'config_pushed', 'config_ack', 'deployment', 'reboot', 'error', 'alarm', 'heartbeat_lost', 'decommissioned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."device_events_severity_enum" AS ENUM('info', 'warning', 'error', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "device_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_id" uuid, "event_type" "sensor"."device_events_event_type_enum" NOT NULL, "severity" "sensor"."device_events_severity_enum" NOT NULL DEFAULT 'info', "message" text NOT NULL, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_808a12fa2283a05c70277d1bfd7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3c797fda9d955d35fd3b8977f3" ON "device_events" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_a8bafdc7464a028ac080f7887f" ON "device_events" ("tenant_id", "event_type") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3715eb6c896724f3287311ec5" ON "device_events" ("tenant_id", "device_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "witnesses" ("tenant_id" uuid NOT NULL, "provisioning_id" uuid NOT NULL, "witness_user_id" uuid NOT NULL, "witness_role" character varying(32) NOT NULL, "witness_signature" bytea NOT NULL, "signed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_994b72450588f27414ea815f4ed" PRIMARY KEY ("provisioning_id", "witness_user_id", "witness_role"))`);
        await queryRunner.query(`CREATE INDEX "IDX_66e6c05804747d981912bbd27d" ON "witnesses" ("tenant_id", "witness_user_id", "signed_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_92a906c8e5fb889fd234cdff16" ON "witnesses" ("tenant_id", "provisioning_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "provisioning_records" ("provisioning_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_id" uuid NOT NULL, "ceremony_type" character varying(32) NOT NULL, "ceremony_at" TIMESTAMP WITH TIME ZONE NOT NULL, "fingerprint_sha256" bytea NOT NULL, "bundle_sha256" bytea NOT NULL, "supersedes_provisioning_id" uuid, "notes" text, "created_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8df13bdcc7fa7bd909a8e7e502c" PRIMARY KEY ("provisioning_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3688552ad0750ddbd706971a87" ON "provisioning_records" ("tenant_id", "ceremony_type") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_57f3edabf119802c208392acb1" ON "provisioning_records" ("tenant_id", "device_id", "ceremony_at") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "policies" ("policy_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_id" uuid NOT NULL, "policy_version" integer NOT NULL, "policy_sha256" bytea NOT NULL, "policy_jws" text NOT NULL, "is_current" boolean NOT NULL DEFAULT false, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b86f8b8459f03f534cc96b43519" PRIMARY KEY ("policy_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_463ab159b7643572876ba2ee73" ON "policies" ("tenant_id", "device_id", "is_current") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ec701657e6cbc644a43c2ac3d4" ON "policies" ("tenant_id", "device_id", "policy_version") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "licenses" ("license_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_id" uuid NOT NULL, "license_jwt" text NOT NULL, "license_sha256" bytea NOT NULL, "plan_tier" character varying(32) NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "revocation_reason" character varying(200), "issued_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a880a1847889df2d497e93a2950" PRIMARY KEY ("license_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7d7e854ac7ebd51d08b7f00380" ON "licenses" ("tenant_id", "device_id", "expires_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0497b4dc169967c6b2a268ba28" ON "licenses" ("tenant_id", "device_id", "license_sha256") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "firmware_releases" ("release_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "hardware_model" character varying(64) NOT NULL, "version" character varying(32) NOT NULL, "artifact_sha256" bytea NOT NULL, "sbom_sha256" bytea NOT NULL, "artifact_uri" text NOT NULL, "firmware_signing_epoch" smallint NOT NULL, "release_notes" text, "released_at" TIMESTAMP WITH TIME ZONE NOT NULL, "released_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2e3a3177cbddf933cebe4b0f23f" PRIMARY KEY ("release_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd3c2d97becb42562d9675fd1d" ON "firmware_releases" ("tenant_id", "released_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9bf86f575f4e39a03facd7f908" ON "firmware_releases" ("tenant_id", "hardware_model", "version") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "devices" ("device_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_code" character varying(64) NOT NULL, "display_name" character varying(200), "hardware_model" character varying(64) NOT NULL, "lifecycle_state" character varying(32) NOT NULL DEFAULT 'provisioned', "provisioning_state" character varying(32) NOT NULL DEFAULT 'pending', "trust_bundle_sha256" bytea NOT NULL, "provisioning_blob_sha256" bytea, "device_audit_attestation_pubkey" bytea, "firmware_signing_epoch" smallint NOT NULL DEFAULT '1', "provisioned_at" TIMESTAMP WITH TIME ZONE, "last_seen_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid NOT NULL, "updated_by" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_2667f40edb344d6f274a0d42b6f" PRIMARY KEY ("device_id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b9f68b5a37b82608a8b5dd1962" ON "devices" ("tenant_id", "device_code") `);
        await queryRunner.query(`CREATE INDEX "IDX_a82d50faff7cad616a5e8bea3b" ON "devices" ("tenant_id", "hardware_model") `);
        await queryRunner.query(`CREATE INDEX "IDX_169c6880a24c0dc6481908491f" ON "devices" ("tenant_id", "lifecycle_state", "provisioning_state") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "audit_archive_v1" ("tenant_id" uuid NOT NULL, "migrated_at" TIMESTAMP WITH TIME ZONE NOT NULL, "archive_id" uuid NOT NULL, "device_id" uuid, "event_type" character varying(64) NOT NULL, "event_payload" jsonb NOT NULL, "event_payload_hash" bytea NOT NULL, "chain_hash" bytea NOT NULL, "prev_chain_hash" bytea, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_839ca6b511e09658337129100b6" PRIMARY KEY ("migrated_at", "archive_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8e8e771463f3a18e8ea0aaa028" ON "audit_archive_v1" ("tenant_id", "chain_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_b00798fd4599455307b19834bb" ON "audit_archive_v1" ("tenant_id", "device_id", "migrated_at") `);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "CHK_edge_devices_trust_bundle_sha256_len" CHECK (octet_length("trust_bundle_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "CHK_edge_devices_provisioning_blob_sha256_len" CHECK ("provisioning_blob_sha256" IS NULL OR octet_length("provisioning_blob_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "CHK_edge_devices_audit_attestation_pubkey_len" CHECK ("device_audit_attestation_pubkey" IS NULL OR octet_length("device_audit_attestation_pubkey") = 32)`);
        await queryRunner.query(`ALTER TABLE "policies" ADD CONSTRAINT "CHK_edge_policies_policy_sha256_len" CHECK (octet_length("policy_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "licenses" ADD CONSTRAINT "CHK_edge_licenses_license_sha256_len" CHECK (octet_length("license_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "firmware_releases" ADD CONSTRAINT "CHK_edge_firmware_artifact_sha256_len" CHECK (octet_length("artifact_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "firmware_releases" ADD CONSTRAINT "CHK_edge_firmware_sbom_sha256_len" CHECK (octet_length("sbom_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "provisioning_records" ADD CONSTRAINT "CHK_edge_provisioning_fingerprint_sha256_len" CHECK (octet_length("fingerprint_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "provisioning_records" ADD CONSTRAINT "CHK_edge_provisioning_bundle_sha256_len" CHECK (octet_length("bundle_sha256") = 32)`);
        await queryRunner.query(`ALTER TABLE "witnesses" ADD CONSTRAINT "CHK_edge_witness_signature_len" CHECK (octet_length("witness_signature") = 64)`);
        await queryRunner.query(`ALTER TABLE "audit_archive_v1" ADD CONSTRAINT "CHK_edge_audit_event_payload_hash_len" CHECK (octet_length("event_payload_hash") = 32)`);
        await queryRunner.query(`ALTER TABLE "audit_archive_v1" ADD CONSTRAINT "CHK_edge_audit_chain_hash_len" CHECK (octet_length("chain_hash") = 32)`);
        await queryRunner.query(`ALTER TABLE "audit_archive_v1" ADD CONSTRAINT "CHK_edge_audit_prev_chain_hash_len" CHECK ("prev_chain_hash" IS NULL OR octet_length("prev_chain_hash") = 32)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_edge_policies_current" ON "policies" ("tenant_id", "device_id") WHERE "is_current"`);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION edge_policies_current_swap()
            RETURNS trigger AS $edge_policy_current$
            BEGIN
              IF NEW.is_current THEN
                UPDATE "policies"
                   SET "is_current" = false
                 WHERE "tenant_id" = NEW."tenant_id"
                   AND "device_id" = NEW."device_id"
                   AND "policy_id" <> NEW."policy_id"
                   AND "is_current" = true;
              END IF;
              RETURN NEW;
            END;
            $edge_policy_current$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER edge_policies_current_swap
            BEFORE INSERT OR UPDATE OF "is_current" ON "policies"
            FOR EACH ROW EXECUTE FUNCTION edge_policies_current_swap();
        `);
        await queryRunner.query(`
            ALTER TABLE "licenses"
            ADD CONSTRAINT "EX_edge_license_no_temporal_overlap"
            EXCLUDE USING gist (
              "tenant_id" WITH =,
              "device_id" WITH =,
              tstzrange("issued_at", "expires_at", '[]') WITH &&
            )
            WHERE ("revoked_at" IS NULL);
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION edge_audit_archive_prevent_update_or_delete()
            RETURNS trigger AS $edge_audit_append_only$
            BEGIN
              RAISE EXCEPTION 'audit_archive_v1 is append-only';
            END;
            $edge_audit_append_only$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER edge_audit_archive_prevent_update_or_delete
            BEFORE UPDATE OR DELETE ON "audit_archive_v1"
            FOR EACH ROW EXECUTE FUNCTION edge_audit_archive_prevent_update_or_delete();
        `);
        await queryRunner.query(`ALTER TABLE "policies" ADD CONSTRAINT "FK_edge_policies_device" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "licenses" ADD CONSTRAINT "FK_edge_licenses_device" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "provisioning_records" ADD CONSTRAINT "FK_edge_provisioning_records_device" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "witnesses" ADD CONSTRAINT "FK_edge_witnesses_provisioning" FOREIGN KEY ("provisioning_id") REFERENCES "provisioning_records"("provisioning_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "audit_archive_v1" ADD CONSTRAINT "FK_edge_audit_archive_device" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "FK_edge_devices_created_by" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "FK_edge_devices_updated_by" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "policies" ADD CONSTRAINT "FK_edge_policies_created_by" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "licenses" ADD CONSTRAINT "FK_edge_licenses_issued_by" FOREIGN KEY ("issued_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "firmware_releases" ADD CONSTRAINT "FK_edge_firmware_releases_released_by" FOREIGN KEY ("released_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "provisioning_records" ADD CONSTRAINT "FK_edge_provisioning_records_created_by" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`ALTER TABLE "witnesses" ADD CONSTRAINT "FK_edge_witnesses_user" FOREIGN KEY ("witness_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "device_groups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "description" text, "type" character varying(50) NOT NULL DEFAULT 'custom', "parent_group_id" uuid, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0a85eb3da91cda682e08b66ae77" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_48733bb3e5f0b4a8ee7bde6c0c" ON "device_groups" ("tenant_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "vfd_automation_rules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "name" character varying(255) NOT NULL, "description" text, "trigger_condition" jsonb NOT NULL, "target_vfd_device_ids" jsonb NOT NULL, "parameter_changes" jsonb NOT NULL, "requires_approval" boolean NOT NULL DEFAULT true, "priority" integer NOT NULL DEFAULT '100', "is_active" boolean NOT NULL DEFAULT true, "last_triggered_at" TIMESTAMP WITH TIME ZONE, "trigger_count" integer NOT NULL DEFAULT '0', "created_by" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_56371e2d7e50be58fc0f69020bb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d2b6b856bd15cc7a861f6bbd3e" ON "vfd_automation_rules" ("tenant_id", "is_active") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "device_group_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "group_id" uuid NOT NULL, "device_type" character varying(50) NOT NULL, "device_id" uuid NOT NULL, "added_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_b96457eddae4eea4154a529f7d0" UNIQUE ("group_id", "device_type", "device_id"), CONSTRAINT "PK_f61a3dd99cd0611ca2e5129d814" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_38edacdc737f29dac08a654ffa" ON "device_group_members" ("device_type", "device_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5339f23f8c7738cb721325e9fc" ON "device_group_members" ("group_id") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "dashboard_layouts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "user_id" character varying, "name" character varying NOT NULL, "description" text, "widgets" jsonb NOT NULL DEFAULT '[]', "process_background" jsonb, "grid_config" jsonb, "grid_version" integer NOT NULL DEFAULT '1', "is_default" boolean NOT NULL DEFAULT false, "is_system_default" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, CONSTRAINT "PK_1850c429674a715d8cb13769efb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3b7f748d773955029ad513813e" ON "dashboard_layouts" ("tenant_id", "is_system_default") `);
        await queryRunner.query(`CREATE INDEX "IDX_f06137059bd217d4ca8d1651b2" ON "dashboard_layouts" ("tenant_id", "user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4d2e060d5baf921e764757d3d4" ON "dashboard_layouts" ("tenant_id") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."program_variables_data_type_enum" AS ENUM('BOOL', 'INT', 'DINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'STRING', 'TIME', 'DATE', 'TOD', 'DT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."program_variables_scope_enum" AS ENUM('local', 'input', 'output', 'inout', 'retain', 'constant'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "program_variables" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "program_id" character varying NOT NULL, "var_name" character varying(50) NOT NULL, "display_name" character varying(100), "description" text, "data_type" "sensor"."program_variables_data_type_enum" NOT NULL DEFAULT 'REAL', "scope" "sensor"."program_variables_scope_enum" NOT NULL DEFAULT 'local', "initial_value" text, "io_config_id" character varying, "io_tag_name" character varying(50), "equipment_node_id" character varying(100), "equipment_property" character varying(50), "sensor_channel_id" character varying, "min_value" numeric(15,4), "max_value" numeric(15,4), "eng_unit" character varying(20), "alarm_hh" numeric(15,4), "alarm_h" numeric(15,4), "alarm_l" numeric(15,4), "alarm_ll" numeric(15,4), "metadata" jsonb, "var_order" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4f1534882ade93024a5c5a42a73" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3353d87673fb01a38346a63f68" ON "program_variables" ("program_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_69749307093e60159a993fef4b" ON "program_variables" ("io_config_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9cca96d236ab2dc791c90dcd4c" ON "program_variables" ("program_id", "scope") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d7b951b7a2f3b638f1dc6b5115" ON "program_variables" ("program_id", "var_name") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."program_transitions_condition_type_enum" AS ENUM('expression', 'timeout', 'always', 'event'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "program_transitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "program_id" character varying NOT NULL, "transition_code" character varying(30) NOT NULL, "transition_name" character varying(100), "description" text, "from_step_id" character varying NOT NULL, "to_step_id" character varying NOT NULL, "from_step_code" character varying(30), "to_step_code" character varying(30), "condition_type" "sensor"."program_transitions_condition_type_enum" NOT NULL DEFAULT 'expression', "condition_expression" text NOT NULL, "transpiled_condition" text, "priority" integer NOT NULL DEFAULT '1', "control_points" jsonb, "timeout_ms" integer, "event_type" character varying(50), "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b5980f20d961eeb3229402df28f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f8c931f39f7fcab318c7da6925" ON "program_transitions" ("program_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_91949351f37117c1fdf9288c10" ON "program_transitions" ("program_id", "to_step_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b565db415bdce19b774bd18d8" ON "program_transitions" ("program_id", "from_step_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7d7db72d6953f36216b2c5657e" ON "program_transitions" ("program_id", "transition_code") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."step_actions_qualifier_enum" AS ENUM('N', 'R', 'S', 'L', 'D', 'P', 'P0', 'P1', 'SD', 'DS', 'SL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."step_actions_action_type_enum" AS ENUM('set_output', 'call_fb', 'assign', 'log', 'alarm', 'timer', 'custom_st'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "step_actions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "step_id" character varying NOT NULL, "action_name" character varying(50) NOT NULL, "description" text, "qualifier" "sensor"."step_actions_qualifier_enum" NOT NULL DEFAULT 'N', "action_type" "sensor"."step_actions_action_type_enum" NOT NULL DEFAULT 'custom_st', "action_code" text NOT NULL, "target_ref" character varying(100), "params" jsonb, "delay_ms" integer, "duration_ms" integer, "action_order" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_83d1dfcd97e3427537ded801ae4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_044357a95d23ea45912bd01d20" ON "step_actions" ("step_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ca965055361b8fdceb816d5da2" ON "step_actions" ("step_id", "action_order") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."program_steps_step_type_enum" AS ENUM('initial', 'normal', 'final'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."program_steps_on_timeout_enum" AS ENUM('abort', 'skip', 'alarm', 'goto'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "program_steps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "program_id" character varying NOT NULL, "step_code" character varying(30) NOT NULL, "step_name" character varying(100) NOT NULL, "step_type" "sensor"."program_steps_step_type_enum" NOT NULL DEFAULT 'normal', "description" text, "position_x" integer NOT NULL DEFAULT '0', "position_y" integer NOT NULL DEFAULT '0', "entry_action" text, "exit_action" text, "timeout_ms" integer, "on_timeout" "sensor"."program_steps_on_timeout_enum", "timeout_target_step" character varying(30), "step_order" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_04b980d0db6d7a9625925959962" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8ef06e0149a6bbea97419eaf2c" ON "program_steps" ("program_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a8740540c3d82039543c9bf0d4" ON "program_steps" ("program_id", "step_type") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_51da0214b6567a051e6aca6dc6" ON "program_steps" ("program_id", "step_code") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."deployment_logs_status_enum" AS ENUM('pending', 'deploying', 'success', 'failed', 'rolled_back'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "deployment_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "program_id" uuid NOT NULL, "device_id" uuid NOT NULL, "command_id" uuid NOT NULL, "version" integer NOT NULL, "status" "sensor"."deployment_logs_status_enum" NOT NULL DEFAULT 'pending', "edge_script" jsonb, "deployed_by" character varying, "deployed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, "edge_ack_at" TIMESTAMP WITH TIME ZONE, "error_message" text, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e6e53af9ad9c4aa87b99d5c5157" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_83cf3e0061bb97b4e33dd32fcf" ON "deployment_logs" ("command_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_37357523be84f7e3ff6a2859b3" ON "deployment_logs" ("tenant_id", "program_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7508f8c02e44d451770183cfa" ON "deployment_logs" ("tenant_id", "device_id") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."automation_programs_program_type_enum" AS ENUM('sfc', 'fbd', 'st', 'ld'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."automation_programs_execution_mode_enum" AS ENUM('manual', 'continuous', 'scheduled', 'triggered'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."automation_programs_status_enum" AS ENUM('draft', 'pending_review', 'approved', 'deploying', 'deployed', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "sensor"."automation_programs_deploy_target_enum" AS ENUM('rust_engine', 'codesys_plc', 'plc_setpoint'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "automation_programs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "device_id" character varying, "process_template_id" character varying, "program_code" character varying(30) NOT NULL, "program_name" character varying(100) NOT NULL, "description" text, "program_type" "sensor"."automation_programs_program_type_enum" NOT NULL DEFAULT 'st', "category" character varying(50), "sfc_definition" jsonb, "structured_text_code" text, "transpiled_js" text, "execution_mode" "sensor"."automation_programs_execution_mode_enum" NOT NULL DEFAULT 'manual', "scan_cycle_ms" integer NOT NULL DEFAULT '100', "priority" integer NOT NULL DEFAULT '5', "trigger_config" jsonb, "version" integer NOT NULL DEFAULT '1', "status" "sensor"."automation_programs_status_enum" NOT NULL DEFAULT 'draft', "deployed_version" integer, "deployed_at" TIMESTAMP WITH TIME ZONE, "deployed_by" character varying, "approved_at" TIMESTAMP WITH TIME ZONE, "approved_by" character varying, "is_locked" boolean NOT NULL DEFAULT false, "locked_by" character varying, "locked_at" TIMESTAMP WITH TIME ZONE, "deploy_target" "sensor"."automation_programs_deploy_target_enum" NOT NULL DEFAULT 'rust_engine', "target_plc_address" character varying(100), "target_plc_port" integer, "target_plc_model" character varying(100), "target_plc_protocol" character varying(50), "tags" jsonb, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, CONSTRAINT "PK_7c3a6768a11677baf9931577cc2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1b857c50d573f1930f70f13f1a" ON "automation_programs" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_42bae96e588cfee2e3111f0133" ON "automation_programs" ("device_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d89aa42e3e38e4b53209446cdb" ON "automation_programs" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3e1a6d7dc66dd29e7f6dbe6bc8" ON "automation_programs" ("tenant_id", "program_code") `);
        await queryRunner.query(`CREATE INDEX "IDX_64eed93997e8f4804be1172185" ON "automation_programs" ("tenant_id", "device_id") `);
        await queryRunner.query(`ALTER TABLE "sensors" ADD CONSTRAINT "FK_662ff86473e2a4fbc892c3463b2" FOREIGN KEY ("protocol_id") REFERENCES "sensor_protocols"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sensors" ADD CONSTRAINT "FK_c42163c44980c1171f186d36655" FOREIGN KEY ("type_definition_id") REFERENCES "sensor_type_definitions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sensors" ADD CONSTRAINT "FK_0c9c45d8d0283ebee985bd76581" FOREIGN KEY ("parent_id") REFERENCES "sensors"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sensor_data_channels" ADD CONSTRAINT "FK_fe6f0c27169af47a4371c0efebb" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sensor_metrics" ADD CONSTRAINT "FK_a41376bfe12979a7c4510892787" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sensor_metrics" ADD CONSTRAINT "FK_6a1def793766bdc6883a231b1b6" FOREIGN KEY ("channel_id") REFERENCES "sensor_data_channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "channel_detection_log" ADD CONSTRAINT "FK_6f62be38cd349f88bb30ed5759e" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vfd_change_set_items" ADD CONSTRAINT "FK_8d7b4c9c9f012299a04dd4f9801" FOREIGN KEY ("change_set_id") REFERENCES "vfd_change_sets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vfd_readings" ADD CONSTRAINT "FK_fbdeb2c3e706814795870612d1e" FOREIGN KEY ("vfd_device_id") REFERENCES "vfd_devices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "feeding_parameters" ADD CONSTRAINT "FK_da3226dde7ffaa0fa19a05e9c1a" FOREIGN KEY ("plcConnectionId") REFERENCES "plc_connections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "lora_devices" ADD CONSTRAINT "FK_48860297d0c89ac5f304c5d35c2" FOREIGN KEY ("edge_device_id") REFERENCES "edge_devices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "device_io_configs" ADD CONSTRAINT "FK_11fd9dd1c092159a58ede2ea864" FOREIGN KEY ("device_id") REFERENCES "edge_devices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "device_groups" ADD CONSTRAINT "FK_6181cff19e35d1e1a5b1c23bd66" FOREIGN KEY ("parent_group_id") REFERENCES "device_groups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "device_group_members" ADD CONSTRAINT "FK_5339f23f8c7738cb721325e9fc6" FOREIGN KEY ("group_id") REFERENCES "device_groups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // ── Faz 3.5 hand-author addition — RLS canonical predicate ──
        await applyTenantRlsToSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });

        // ── Faz 3.5 hand-author addition — audit immutability triggers ──
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "sensor".sensor_audit_logs_prevent_update_or_delete()
            RETURNS trigger AS $auditguard$
            BEGIN
              RAISE EXCEPTION 'Audit table "sensor"."sensor_audit_logs" is append-only; UPDATE/DELETE refused (Faz 1.4 protected-tables-guard).';
            END;
            $auditguard$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE OR REPLACE TRIGGER trg_sensor_audit_logs_prevent_update
            BEFORE UPDATE OR DELETE ON "sensor"."sensor_audit_logs"
            FOR EACH ROW EXECUTE FUNCTION "sensor".sensor_audit_logs_prevent_update_or_delete();
        `);
        await queryRunner.query(`
            REVOKE UPDATE, DELETE ON "sensor"."sensor_audit_logs" FROM PUBLIC;
        `);

        // ── Faz 3.5 hand-author addition — TimescaleDB hypertables + CAGGs ──
        //
        // Column SSoT (mirrored from CREATE TABLE statements above):
        //   sensor.sensor_readings → time-partition column is "timestamp"
        //     (entity: apps/sensor-service/src/entities/sensor-reading.entity.ts;
        //      not "time" — that was a 2026-05-18 cutover bug that blocked
        //      Phase 1 of the platform-bootstrap deploy)
        //   sensor.sensor_metrics  → time-partition column is "time"
        //     (entity: apps/sensor-service/src/entities/sensor-metric.entity.ts;
        //      PK includes "time", canonical TimescaleDB convention)
        //
        // create_hypertable expects an EXISTING column on the target table.
        // Drift between baseline DDL and this call surfaces as
        // "column \"<name>\" does not exist" — fail-fast and unambiguous.
        await queryRunner.query(`SELECT create_hypertable('sensor.sensor_readings', 'timestamp', if_not_exists => true);`);
        await queryRunner.query(`SELECT create_hypertable('sensor.sensor_metrics',  'time',      if_not_exists => true);`);
        // CAGG policies are appended post-cutover via separate runbook step
        // (sensor_metrics 1min/1hour/1day rollups require parametric add_continuous_aggregate_policy
        // calls that depend on the view definitions; tracked as OPEN-ADR-030-CAGG).
    }

    // ── GENERATED postCondition (DATA-CRITICAL-010) — do not hand-edit ──
    public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
        const rows: Array<{ missing: string }> = await queryRunner.query(`
            SELECT expected.table_name AS missing
              FROM (VALUES ('audit_archive_v1'), ('automation_programs'), ('channel_detection_log'), ('dashboard_layouts'), ('deployment_logs'), ('device_events'), ('device_group_members'), ('device_groups'), ('device_io_configs'), ('devices'), ('edge_devices'), ('feeding_parameters'), ('firmware_releases'), ('industry_templates'), ('licenses'), ('lora_devices'), ('plc_alarms'), ('plc_connections'), ('plc_telemetry'), ('policies'), ('processes'), ('program_steps'), ('program_transitions'), ('program_variables'), ('provisioning_records'), ('scada_deploy_logs'), ('scada_packages'), ('sensor_data_channels'), ('sensor_metrics'), ('sensor_protocols'), ('sensor_type_definitions'), ('sensors'), ('step_actions'), ('tenant_provisioning_keys'), ('unified_tags'), ('vfd_automation_rules'), ('vfd_change_set_items'), ('vfd_change_sets'), ('vfd_devices'), ('vfd_parameter_audit_logs'), ('vfd_parameter_definitions'), ('vfd_readings'), ('witnesses')) AS expected(table_name)
             WHERE NOT EXISTS (
               SELECT 1
                 FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name = expected.table_name
             )
        `);
        return rows.length === 0;
    }
    // ── END GENERATED postCondition ──

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse Faz 3.5 audit immutability triggers
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_sensor_audit_logs_prevent_update ON "sensor"."sensor_audit_logs";`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "sensor".sensor_audit_logs_prevent_update_or_delete();`);
        // Reverse Faz 3.5 RLS install first (avoids policy-on-missing-table errors).
        await removeTenantRlsFromSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });
        await queryRunner.query(`ALTER TABLE "device_group_members" DROP CONSTRAINT "FK_5339f23f8c7738cb721325e9fc6"`);
        await queryRunner.query(`ALTER TABLE "device_groups" DROP CONSTRAINT "FK_6181cff19e35d1e1a5b1c23bd66"`);
        await queryRunner.query(`ALTER TABLE "device_io_configs" DROP CONSTRAINT "FK_11fd9dd1c092159a58ede2ea864"`);
        await queryRunner.query(`ALTER TABLE "lora_devices" DROP CONSTRAINT "FK_48860297d0c89ac5f304c5d35c2"`);
        await queryRunner.query(`ALTER TABLE "feeding_parameters" DROP CONSTRAINT "FK_da3226dde7ffaa0fa19a05e9c1a"`);
        await queryRunner.query(`ALTER TABLE "vfd_readings" DROP CONSTRAINT "FK_fbdeb2c3e706814795870612d1e"`);
        await queryRunner.query(`ALTER TABLE "vfd_change_set_items" DROP CONSTRAINT "FK_8d7b4c9c9f012299a04dd4f9801"`);
        await queryRunner.query(`ALTER TABLE "channel_detection_log" DROP CONSTRAINT "FK_6f62be38cd349f88bb30ed5759e"`);
        await queryRunner.query(`ALTER TABLE "sensor_metrics" DROP CONSTRAINT "FK_6a1def793766bdc6883a231b1b6"`);
        await queryRunner.query(`ALTER TABLE "sensor_metrics" DROP CONSTRAINT "FK_a41376bfe12979a7c4510892787"`);
        await queryRunner.query(`ALTER TABLE "sensor_data_channels" DROP CONSTRAINT "FK_fe6f0c27169af47a4371c0efebb"`);
        await queryRunner.query(`ALTER TABLE "sensors" DROP CONSTRAINT "FK_0c9c45d8d0283ebee985bd76581"`);
        await queryRunner.query(`ALTER TABLE "sensors" DROP CONSTRAINT "FK_c42163c44980c1171f186d36655"`);
        await queryRunner.query(`ALTER TABLE "sensors" DROP CONSTRAINT "FK_662ff86473e2a4fbc892c3463b2"`);
        await queryRunner.query(`DROP INDEX "IDX_64eed93997e8f4804be1172185"`);
        await queryRunner.query(`DROP INDEX "IDX_3e1a6d7dc66dd29e7f6dbe6bc8"`);
        await queryRunner.query(`DROP INDEX "IDX_d89aa42e3e38e4b53209446cdb"`);
        await queryRunner.query(`DROP INDEX "IDX_42bae96e588cfee2e3111f0133"`);
        await queryRunner.query(`DROP INDEX "IDX_1b857c50d573f1930f70f13f1a"`);
        await queryRunner.query(`DROP TABLE "automation_programs"`);
        await queryRunner.query(`DROP TYPE "sensor"."automation_programs_deploy_target_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."automation_programs_status_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."automation_programs_execution_mode_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."automation_programs_program_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_e7508f8c02e44d451770183cfa"`);
        await queryRunner.query(`DROP INDEX "IDX_37357523be84f7e3ff6a2859b3"`);
        await queryRunner.query(`DROP INDEX "IDX_83cf3e0061bb97b4e33dd32fcf"`);
        await queryRunner.query(`DROP TABLE "deployment_logs"`);
        await queryRunner.query(`DROP TYPE "sensor"."deployment_logs_status_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_51da0214b6567a051e6aca6dc6"`);
        await queryRunner.query(`DROP INDEX "IDX_a8740540c3d82039543c9bf0d4"`);
        await queryRunner.query(`DROP INDEX "IDX_8ef06e0149a6bbea97419eaf2c"`);
        await queryRunner.query(`DROP TABLE "program_steps"`);
        await queryRunner.query(`DROP TYPE "sensor"."program_steps_on_timeout_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."program_steps_step_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_ca965055361b8fdceb816d5da2"`);
        await queryRunner.query(`DROP INDEX "IDX_044357a95d23ea45912bd01d20"`);
        await queryRunner.query(`DROP TABLE "step_actions"`);
        await queryRunner.query(`DROP TYPE "sensor"."step_actions_action_type_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."step_actions_qualifier_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_7d7db72d6953f36216b2c5657e"`);
        await queryRunner.query(`DROP INDEX "IDX_5b565db415bdce19b774bd18d8"`);
        await queryRunner.query(`DROP INDEX "IDX_91949351f37117c1fdf9288c10"`);
        await queryRunner.query(`DROP INDEX "IDX_f8c931f39f7fcab318c7da6925"`);
        await queryRunner.query(`DROP TABLE "program_transitions"`);
        await queryRunner.query(`DROP TYPE "sensor"."program_transitions_condition_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_d7b951b7a2f3b638f1dc6b5115"`);
        await queryRunner.query(`DROP INDEX "IDX_9cca96d236ab2dc791c90dcd4c"`);
        await queryRunner.query(`DROP INDEX "IDX_69749307093e60159a993fef4b"`);
        await queryRunner.query(`DROP INDEX "IDX_3353d87673fb01a38346a63f68"`);
        await queryRunner.query(`DROP TABLE "program_variables"`);
        await queryRunner.query(`DROP TYPE "sensor"."program_variables_scope_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."program_variables_data_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_4d2e060d5baf921e764757d3d4"`);
        await queryRunner.query(`DROP INDEX "IDX_f06137059bd217d4ca8d1651b2"`);
        await queryRunner.query(`DROP INDEX "IDX_3b7f748d773955029ad513813e"`);
        await queryRunner.query(`DROP TABLE "dashboard_layouts"`);
        await queryRunner.query(`DROP INDEX "IDX_5339f23f8c7738cb721325e9fc"`);
        await queryRunner.query(`DROP INDEX "IDX_38edacdc737f29dac08a654ffa"`);
        await queryRunner.query(`DROP TABLE "device_group_members"`);
        await queryRunner.query(`DROP INDEX "IDX_d2b6b856bd15cc7a861f6bbd3e"`);
        await queryRunner.query(`DROP TABLE "vfd_automation_rules"`);
        await queryRunner.query(`DROP INDEX "IDX_48733bb3e5f0b4a8ee7bde6c0c"`);
        await queryRunner.query(`DROP TABLE "device_groups"`);
        await queryRunner.query(`DROP INDEX "IDX_b00798fd4599455307b19834bb"`);
        await queryRunner.query(`DROP INDEX "IDX_8e8e771463f3a18e8ea0aaa028"`);
        await queryRunner.query(`DROP TABLE "audit_archive_v1"`);
        await queryRunner.query(`DROP INDEX "IDX_169c6880a24c0dc6481908491f"`);
        await queryRunner.query(`DROP INDEX "IDX_a82d50faff7cad616a5e8bea3b"`);
        await queryRunner.query(`DROP INDEX "IDX_b9f68b5a37b82608a8b5dd1962"`);
        await queryRunner.query(`DROP TABLE "devices"`);
        await queryRunner.query(`DROP INDEX "IDX_9bf86f575f4e39a03facd7f908"`);
        await queryRunner.query(`DROP INDEX "IDX_dd3c2d97becb42562d9675fd1d"`);
        await queryRunner.query(`DROP TABLE "firmware_releases"`);
        await queryRunner.query(`DROP INDEX "IDX_0497b4dc169967c6b2a268ba28"`);
        await queryRunner.query(`DROP INDEX "IDX_7d7e854ac7ebd51d08b7f00380"`);
        await queryRunner.query(`DROP TABLE "licenses"`);
        await queryRunner.query(`DROP INDEX "IDX_ec701657e6cbc644a43c2ac3d4"`);
        await queryRunner.query(`DROP INDEX "IDX_463ab159b7643572876ba2ee73"`);
        await queryRunner.query(`DROP TABLE "policies"`);
        await queryRunner.query(`DROP INDEX "IDX_57f3edabf119802c208392acb1"`);
        await queryRunner.query(`DROP INDEX "IDX_3688552ad0750ddbd706971a87"`);
        await queryRunner.query(`DROP TABLE "provisioning_records"`);
        await queryRunner.query(`DROP INDEX "IDX_92a906c8e5fb889fd234cdff16"`);
        await queryRunner.query(`DROP INDEX "IDX_66e6c05804747d981912bbd27d"`);
        await queryRunner.query(`DROP TABLE "witnesses"`);
        await queryRunner.query(`DROP INDEX "IDX_e3715eb6c896724f3287311ec5"`);
        await queryRunner.query(`DROP INDEX "IDX_a8bafdc7464a028ac080f7887f"`);
        await queryRunner.query(`DROP INDEX "IDX_3c797fda9d955d35fd3b8977f3"`);
        await queryRunner.query(`DROP TABLE "device_events"`);
        await queryRunner.query(`DROP TYPE "sensor"."device_events_severity_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."device_events_event_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_09bffbc3f2febc9f589aff6614"`);
        await queryRunner.query(`DROP INDEX "IDX_7729fd7b2767fe51ca19628090"`);
        await queryRunner.query(`DROP TABLE "device_io_configs"`);
        await queryRunner.query(`DROP TYPE "sensor"."device_io_configs_data_type_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."device_io_configs_io_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_9dab81dea827e9c031b120ee44"`);
        await queryRunner.query(`DROP INDEX "IDX_6906bb3449ae2bab2fb224500d"`);
        await queryRunner.query(`DROP TABLE "lora_devices"`);
        await queryRunner.query(`DROP TYPE "sensor"."lora_devices_device_class_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."lora_devices_activation_mode_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_4e8f558f533ae811b65ec7c75d"`);
        await queryRunner.query(`DROP INDEX "IDX_242731453afdc96bf3e827f90d"`);
        await queryRunner.query(`DROP INDEX "IDX_6647fe3f99b17d234896ae0933"`);
        await queryRunner.query(`DROP INDEX "IDX_75736011e0fb0cd817ca612a2a"`);
        await queryRunner.query(`DROP INDEX "IDX_edge_devices_serial_number"`);
        await queryRunner.query(`DROP INDEX "IDX_d2e2cfe76509f8a5b41740c39d"`);
        await queryRunner.query(`DROP INDEX "IDX_efe55fa5f6a895eb9edfb81d5a"`);
        await queryRunner.query(`DROP TABLE "edge_devices"`);
        await queryRunner.query(`DROP TYPE "sensor"."edge_devices_lifecycle_state_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."edge_devices_device_model_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_16fc3fc7e0e4e8023bc5ea9d34"`);
        await queryRunner.query(`DROP INDEX "IDX_445c3ed7df2859c8d59d1b6408"`);
        await queryRunner.query(`DROP TABLE "tenant_provisioning_keys"`);
        await queryRunner.query(`DROP INDEX "IDX_d2e123cdb64f6ed10965baee94"`);
        await queryRunner.query(`DROP INDEX "IDX_2249a91eb2ce78f6b55de6ca66"`);
        await queryRunner.query(`DROP INDEX "IDX_1ea3e2254e107b1caff65564f9"`);
        await queryRunner.query(`DROP TABLE "feeding_parameters"`);
        await queryRunner.query(`DROP INDEX "IDX_790af4ecae00bf341562600c40"`);
        await queryRunner.query(`DROP INDEX "IDX_b09dd93b839527c06fab1d1868"`);
        await queryRunner.query(`DROP INDEX "IDX_9c01d78a4e5aab2d32f8fb5130"`);
        await queryRunner.query(`DROP INDEX "IDX_68df53f42ed34d1383a0a32228"`);
        await queryRunner.query(`DROP TABLE "plc_alarms"`);
        await queryRunner.query(`DROP INDEX "IDX_37a6b9524cdc966ddc53292b44"`);
        await queryRunner.query(`DROP INDEX "IDX_e4c1a8a0110af5f90766c20fce"`);
        await queryRunner.query(`DROP TABLE "plc_connections"`);
        await queryRunner.query(`DROP INDEX "IDX_02a56317521fe5f1901b66f4ed"`);
        await queryRunner.query(`DROP INDEX "IDX_d3960cbf31cf63d54248e760f8"`);
        await queryRunner.query(`DROP INDEX "IDX_28066c3a557ad6a5b72ace20b0"`);
        await queryRunner.query(`DROP TABLE "plc_telemetry"`);
        await queryRunner.query(`DROP INDEX "IDX_6e41e1a73e5b33b051e58ec2e1"`);
        await queryRunner.query(`DROP INDEX "IDX_59a27fec5591df8bedf39e892b"`);
        await queryRunner.query(`DROP INDEX "IDX_41eb2461c733df4d36f56375a7"`);
        await queryRunner.query(`DROP INDEX "IDX_0dad5402604429197412690a76"`);
        await queryRunner.query(`DROP TABLE "processes"`);
        await queryRunner.query(`DROP TYPE "sensor"."processes_status_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_4a66dae20855f80b3df131642f"`);
        await queryRunner.query(`DROP INDEX "IDX_fb3cfe123943e43090f92af6e3"`);
        await queryRunner.query(`DROP INDEX "IDX_b381db4a8e08c550780dcbff61"`);
        await queryRunner.query(`DROP TABLE "scada_deploy_logs"`);
        await queryRunner.query(`DROP TYPE "sensor"."scada_deploy_logs_status_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_a6d9f66fb4bea82e1e5e20d453"`);
        await queryRunner.query(`DROP INDEX "IDX_04afe40713d67d6d2949649a19"`);
        await queryRunner.query(`DROP TABLE "scada_packages"`);
        await queryRunner.query(`DROP TYPE "sensor"."scada_packages_status_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_31a1a988d2dca6be2b4387a10b"`);
        await queryRunner.query(`DROP INDEX "IDX_7aafbe6e48afee69e377bfc96b"`);
        await queryRunner.query(`DROP TABLE "unified_tags"`);
        await queryRunner.query(`DROP TYPE "sensor"."unified_tags_direction_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."unified_tags_data_type_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."unified_tags_io_type_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_ce291c730d3e027c512b029fa3"`);
        await queryRunner.query(`DROP INDEX "IDX_f1854b90eea1d29d7abdf5ff26"`);
        await queryRunner.query(`DROP INDEX "IDX_6f2fe4f58bed066b6f1e77ef19"`);
        await queryRunner.query(`DROP INDEX "IDX_0559dc2a76d3f69400def2281d"`);
        await queryRunner.query(`DROP INDEX "IDX_fbdeb2c3e706814795870612d1"`);
        await queryRunner.query(`DROP TABLE "vfd_readings"`);
        await queryRunner.query(`DROP INDEX "IDX_5753ebcc5ddbdd2a73b2c5d8b9"`);
        await queryRunner.query(`DROP INDEX "IDX_e58e1334f05fe59384924706d6"`);
        await queryRunner.query(`DROP INDEX "IDX_d98c50eadb87a3ca53bd0674b3"`);
        await queryRunner.query(`DROP INDEX "IDX_8dbec8dad1775903e3f6eb9db1"`);
        await queryRunner.query(`DROP TABLE "vfd_devices"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_e57231f95c307cb75b326af633"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_a684c060f0c5755d75d6a89dfd"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_28e3f61e6e4831f6367fd3c42e"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_277fb0384f12ff475407283d22"`);
        await queryRunner.query(`DROP TABLE "sensor"."vfd_register_mappings"`);
        await queryRunner.query(`DROP INDEX "IDX_271cddf4c36660be270d80cd37"`);
        await queryRunner.query(`DROP INDEX "IDX_fc0920cc636dcb8c07781008ae"`);
        await queryRunner.query(`DROP TABLE "vfd_change_sets"`);
        await queryRunner.query(`DROP INDEX "IDX_8d7b4c9c9f012299a04dd4f980"`);
        await queryRunner.query(`DROP TABLE "vfd_change_set_items"`);
        await queryRunner.query(`DROP INDEX "IDX_71e3e037cb99567da9443707a2"`);
        await queryRunner.query(`DROP INDEX "IDX_bc85ed7a1260e3464f9d6d32df"`);
        await queryRunner.query(`DROP TABLE "vfd_parameter_audit_logs"`);
        await queryRunner.query(`DROP INDEX "IDX_c1869c159ad03f8fdedd9825c2"`);
        await queryRunner.query(`DROP INDEX "IDX_bbe01ccebc458c038d4e052286"`);
        await queryRunner.query(`DROP TABLE "vfd_parameter_definitions"`);
        await queryRunner.query(`DROP TABLE "industry_templates"`);
        await queryRunner.query(`DROP INDEX "IDX_ebc92a57969fe6c5ca27da4ae6"`);
        await queryRunner.query(`DROP INDEX "IDX_6f62be38cd349f88bb30ed5759"`);
        await queryRunner.query(`DROP TABLE "channel_detection_log"`);
        await queryRunner.query(`DROP INDEX "IDX_ac69ebd076edf1a5978722747d"`);
        await queryRunner.query(`DROP INDEX "IDX_d528fb7f99fae26f611eadc7b3"`);
        await queryRunner.query(`DROP INDEX "IDX_820e5dc30e11a2a47b5358868d"`);
        await queryRunner.query(`DROP INDEX "IDX_411b104d2bcf2c83d09b806bb8"`);
        await queryRunner.query(`DROP INDEX "IDX_f8ed794f2cdefbadbbd14f7368"`);
        await queryRunner.query(`DROP TABLE "sensor_metrics"`);
        await queryRunner.query(`DROP INDEX "IDX_28f8895a1f2731b3fdda60b64b"`);
        await queryRunner.query(`DROP INDEX "IDX_39626616a2d8ed5cbb2c819e00"`);
        await queryRunner.query(`DROP INDEX "IDX_902eb2436271895c7a853da52f"`);
        await queryRunner.query(`DROP INDEX "IDX_fe6f0c27169af47a4371c0efeb"`);
        await queryRunner.query(`DROP TABLE "sensor_data_channels"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensor_data_channels_discovery_source_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensor_data_channels_data_type_enum"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_0376e08a5128b463a79a811084"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_79b6ae4cba75c33361355806d1"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_ce4ad1c5885cf09dc41939fda6"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_09d7dd109cd8f0f1a59aaac78a"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_9417244ed127d5ef9f2b46750a"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_d1df5a824e4467f5a645d7b362"`);
        await queryRunner.query(`DROP TABLE "sensor"."sensor_readings"`);
        await queryRunner.query(`DROP INDEX "IDX_0565c3267d3cb4204a1757c1b7"`);
        await queryRunner.query(`DROP INDEX "IDX_sensors_serial_number"`);
        await queryRunner.query(`DROP INDEX "IDX_0f886866b8ffc4d4a9bce2ad15"`);
        await queryRunner.query(`DROP INDEX "IDX_c93462be0545df6b48615dbddf"`);
        await queryRunner.query(`DROP INDEX "IDX_3f299085726ca10771b3e6a8c5"`);
        await queryRunner.query(`DROP INDEX "IDX_3825b39a36779086c0b33d8336"`);
        await queryRunner.query(`DROP INDEX "IDX_0c9c45d8d0283ebee985bd7658"`);
        await queryRunner.query(`DROP INDEX "IDX_662ff86473e2a4fbc892c3463b"`);
        await queryRunner.query(`DROP INDEX "IDX_7213900c3ed0bc3d42bc28cd54"`);
        await queryRunner.query(`DROP INDEX "IDX_ff1a805621c439ebd7bae48048"`);
        await queryRunner.query(`DROP INDEX "IDX_e435eecf5b38444c7d6352a95c"`);
        await queryRunner.query(`DROP INDEX "IDX_8021d035f80450c85300e62d29"`);
        await queryRunner.query(`DROP INDEX "IDX_ea42ff64e4f254995112843ac9"`);
        await queryRunner.query(`DROP INDEX "IDX_59b028bdc5d22fcfa1e8904943"`);
        await queryRunner.query(`DROP INDEX "IDX_fd691555a1970ea5fbadd3e2b4"`);
        await queryRunner.query(`DROP TABLE "sensors"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensors_sensor_role_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensors_registration_status_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensors_status_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensors_type_enum"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_640549f962a7279884081bfe1e"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_591c741761e2a3037dedf9d3a3"`);
        await queryRunner.query(`DROP INDEX "sensor"."IDX_d4f984848932af43f8aaaebc32"`);
        await queryRunner.query(`DROP TABLE "sensor"."sensor_audit_logs"`);
        await queryRunner.query(`DROP INDEX "IDX_4806b50944810eb8471733f1b0"`);
        await queryRunner.query(`DROP TABLE "sensor_type_definitions"`);
        await queryRunner.query(`DROP INDEX "IDX_458edeec38b72795b233f07ff5"`);
        await queryRunner.query(`DROP INDEX "IDX_90ad882ddf58a754837c834b02"`);
        await queryRunner.query(`DROP INDEX "IDX_c7cb37ac08d5ba271f84ac0fe9"`);
        await queryRunner.query(`DROP TABLE "sensor_protocols"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensor_protocols_connectiontype_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensor_protocols_subcategory_enum"`);
        await queryRunner.query(`DROP TYPE "sensor"."sensor_protocols_category_enum"`);
    }

}
