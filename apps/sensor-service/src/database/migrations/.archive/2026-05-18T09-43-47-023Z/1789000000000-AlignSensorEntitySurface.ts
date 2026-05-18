import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignSensorEntitySurface1789000000000
 * ============================================================================
 *
 * Closes the entity-vs-DB drift surface that the bootstrap-from-scratch
 * test (W4-A2-D2 sensor baseline) flagged on 2026-05-08: 51 distinct
 * drifts spanning 10 entirely-missing tables, 30+ missing columns on
 * four partially-created automation tables, and 6 missing indexes
 * that the entity decorators declare. Single align step that brings
 * the `sensor` source-schema surface into 1:1 alignment with the
 * entity decorators as of W4-A2.
 *
 * # Why a single align migration (not 10 separate creates)
 *
 * The drifts originate from a single root cause — the W4-A2 sensor
 * baseline was sliced before the VFD programming, PLC control, edge
 * device-event, automation deployment-log, and richer SFC entity
 * surfaces had been included.
 *
 * # Idempotency posture (every DDL re-runnable)
 *
 *   - Tables: `CREATE TABLE IF NOT EXISTS`.
 *   - Columns: `ADD COLUMN IF NOT EXISTS`.
 *   - Enum types: `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN
 *     duplicate_object THEN NULL; END $$`.
 *   - Constraints: `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT …
 *     EXCEPTION WHEN duplicate_object THEN NULL; END $$`.
 *   - Indexes: `CREATE INDEX IF NOT EXISTS`.
 *
 * # NOT NULL backfill protocol
 *
 * NOT NULL columns added to populated tables use the single-statement
 * `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT <safe-literal>` form —
 * R2 accepts this; PG ≥ 11 attmissingval makes it metadata-only with
 * no row rewrite. Empty in every W4-A2 environment because the
 * automation tables were created by 1740300001000 but the entity
 * surface diverged before seeding could land.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignSensorEntitySurface1789000000000
  implements MigrationInterface
{
  name = 'AlignSensorEntitySurface1789000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'sensor');

    this.logger.log(
      'Aligning sensor schema with entity surface (10 tables, 38 columns, ' +
        '8 indexes, 6 enums) — W4-A2-D2 baseline gap closure.',
    );

    await this.createMissingEnumTypes(queryRunner);

    await this.createVfdParameterDefinitionsTable(queryRunner);
    await this.createVfdRegisterMappingsTable(queryRunner);
    await this.createVfdAutomationRulesTable(queryRunner);
    await this.createVfdChangeSetsTable(queryRunner);
    await this.createVfdChangeSetItemsTable(queryRunner);
    await this.createVfdParameterAuditLogsTable(queryRunner);
    await this.createPlcTelemetryTable(queryRunner);
    await this.createPlcAlarmsTable(queryRunner);
    await this.createDeviceEventsTable(queryRunner);
    await this.createDeploymentLogsTable(queryRunner);

    await this.alignProgramStepsColumns(queryRunner);
    await this.alignProgramTransitionsColumns(queryRunner);
    await this.alignProgramVariablesColumns(queryRunner);
    await this.alignStepActionsColumns(queryRunner);

    this.logger.log('Sensor schema alignment complete.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting AlignSensorEntitySurface — destructive, intended ' +
        'for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      'deployment_logs',
      'device_events',
      'plc_alarms',
      'plc_telemetry',
      'vfd_parameter_audit_logs',
      'vfd_change_set_items',
      'vfd_change_sets',
      'vfd_automation_rules',
      'vfd_register_mappings',
      'vfd_parameter_definitions',
    ];
    for (const t of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS sensor."${t}" CASCADE`);
    }

    const enumTypes = [
      'step_actions_action_type_enum',
      'program_transitions_condition_type_enum',
      'program_steps_on_timeout_enum',
      'deployment_logs_status_enum',
      'device_events_event_type_enum',
      'device_events_severity_enum',
    ];
    for (const e of enumTypes) {
      await queryRunner.query(`DROP TYPE IF EXISTS sensor."${e}" CASCADE`);
    }
  }

  private async createMissingEnumTypes(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      {
        name: 'program_steps_on_timeout_enum',
        values: ['abort', 'skip', 'alarm', 'goto'],
      },
      {
        name: 'program_transitions_condition_type_enum',
        values: ['expression', 'timeout', 'always', 'event'],
      },
      {
        name: 'step_actions_action_type_enum',
        values: [
          'set_output',
          'call_fb',
          'assign',
          'log',
          'alarm',
          'timer',
          'custom_st',
        ],
      },
      {
        name: 'device_events_severity_enum',
        values: ['info', 'warning', 'error', 'critical'],
      },
      {
        name: 'device_events_event_type_enum',
        values: [
          'self_registered',
          'approved',
          'connected',
          'disconnected',
          'config_pushed',
          'config_ack',
          'deployment',
          'reboot',
          'error',
          'alarm',
          'heartbeat_lost',
          'decommissioned',
        ],
      },
      {
        name: 'deployment_logs_status_enum',
        values: ['pending', 'deploying', 'success', 'failed', 'rolled_back'],
      },
    ];

    for (const e of enums) {
      const literals = e.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE sensor."${e.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  private async createVfdParameterDefinitionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_parameter_definitions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid,
        "brand" varchar(50) NOT NULL,
        "model_series" varchar(100),
        "parameter_name" varchar(100) NOT NULL,
        "display_name" varchar(255) NOT NULL,
        "description" text,
        "category" varchar(50) NOT NULL DEFAULT 'configuration',
        "group" varchar(50) NOT NULL,
        "register_address" integer NOT NULL,
        "register_count" integer NOT NULL DEFAULT 1,
        "function_code" integer NOT NULL DEFAULT 6,
        "data_type" varchar(50) NOT NULL DEFAULT 'uint16',
        "scaling_factor" double precision NOT NULL DEFAULT 1,
        "offset" double precision NOT NULL DEFAULT 0,
        "unit" varchar(20),
        "byte_order" varchar(10) NOT NULL DEFAULT 'big',
        "word_order" varchar(10) NOT NULL DEFAULT 'big',
        "min_value" double precision,
        "max_value" double precision,
        "default_value" double precision,
        "step" double precision,
        "risk_level" varchar(20) NOT NULL DEFAULT 'medium',
        "requires_motor_stop" boolean NOT NULL DEFAULT false,
        "is_readable" boolean NOT NULL DEFAULT true,
        "is_writable" boolean NOT NULL DEFAULT true,
        "is_active" boolean NOT NULL DEFAULT true,
        "display_order" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_vfd_param_defs_brand_model_param"
          UNIQUE ("brand", "model_series", "parameter_name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_param_defs_brand"
        ON sensor.vfd_parameter_definitions ("brand");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_param_defs_brand_group"
        ON sensor.vfd_parameter_definitions ("brand", "group");
    `);
  }

  private async createVfdRegisterMappingsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_register_mappings (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "brand" varchar(50) NOT NULL,
        "model_series" varchar(100),
        "parameter_name" varchar(100) NOT NULL,
        "display_name" varchar(255) NOT NULL,
        "description" text,
        "category" varchar(50) NOT NULL,
        "registerAddress" integer NOT NULL,
        "register_count" integer NOT NULL DEFAULT 1,
        "function_code" integer NOT NULL DEFAULT 3,
        "data_type" varchar(50) NOT NULL DEFAULT 'uint16',
        "scaling_factor" numeric(15, 6) NOT NULL DEFAULT 1,
        "offset" numeric(15, 6) NOT NULL DEFAULT 0,
        "unit" varchar(20),
        "byte_order" varchar(10) NOT NULL DEFAULT 'big',
        "word_order" varchar(10) NOT NULL DEFAULT 'big',
        "is_bit_field" boolean NOT NULL DEFAULT false,
        "bit_definitions" jsonb,
        "is_readable" boolean NOT NULL DEFAULT true,
        "is_writable" boolean NOT NULL DEFAULT false,
        "recommended_poll_interval_ms" integer NOT NULL DEFAULT 500,
        "display_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_critical" boolean NOT NULL DEFAULT false,
        "min_value" numeric(15, 6),
        "max_value" numeric(15, 6),
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_vfd_register_mappings_brand_model_param"
          UNIQUE ("brand", "model_series", "parameter_name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_register_mappings_brand"
        ON sensor.vfd_register_mappings ("brand");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_register_mappings_brand_model"
        ON sensor.vfd_register_mappings ("brand", "model_series");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_register_mappings_brand_param"
        ON sensor.vfd_register_mappings ("brand", "parameter_name");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_register_mappings_category"
        ON sensor.vfd_register_mappings ("category");
    `);
  }

  private async createVfdAutomationRulesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_automation_rules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "trigger_condition" jsonb NOT NULL,
        "target_vfd_device_ids" jsonb NOT NULL,
        "parameter_changes" jsonb NOT NULL,
        "requires_approval" boolean NOT NULL DEFAULT true,
        "priority" integer NOT NULL DEFAULT 100,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_triggered_at" timestamptz,
        "trigger_count" integer NOT NULL DEFAULT 0,
        "created_by" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_automation_rules_tenant_active"
        ON sensor.vfd_automation_rules ("tenant_id", "is_active");
    `);
  }

  private async createVfdChangeSetsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_change_sets (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "vfd_device_id" uuid NOT NULL,
        "status" varchar(30) NOT NULL DEFAULT 'draft',
        "description" text NOT NULL,
        "created_by" uuid NOT NULL,
        "approved_by" uuid,
        "rejected_by" uuid,
        "rejection_reason" text,
        "applied_at" timestamptz,
        "verified_at" timestamptz,
        "scheduled_at" timestamptz,
        "automation_rule_id" uuid,
        "rollback_of_id" uuid,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_change_sets_tenant_device"
        ON sensor.vfd_change_sets ("tenant_id", "vfd_device_id");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_change_sets_tenant_status"
        ON sensor.vfd_change_sets ("tenant_id", "status");
    `);
  }

  private async createVfdChangeSetItemsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_change_set_items (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "change_set_id" uuid NOT NULL,
        "parameter_definition_id" uuid NOT NULL,
        "parameter_name" varchar(100) NOT NULL,
        "previous_value" numeric(15, 6),
        "requested_value" numeric(15, 6) NOT NULL,
        "applied_value" numeric(15, 6),
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "error_message" text,
        "applied_at" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_change_set_items_change_set"
        ON sensor.vfd_change_set_items ("change_set_id");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.vfd_change_set_items
          ADD CONSTRAINT "FK_vfd_change_set_items_change_set"
          FOREIGN KEY ("change_set_id")
          REFERENCES sensor.vfd_change_sets("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async createVfdParameterAuditLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_parameter_audit_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "vfd_device_id" uuid NOT NULL,
        "change_set_id" uuid,
        "parameter_name" varchar(100) NOT NULL,
        "previous_value" numeric(15, 6),
        "new_value" numeric(15, 6) NOT NULL,
        "action" varchar(30) NOT NULL,
        "performed_by" varchar(255) NOT NULL,
        "client_ip" varchar(45),
        "user_agent" varchar(500),
        "automation_rule_id" uuid,
        "metadata" jsonb,
        "timestamp" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_vfd_param_audit_tenant_device_ts"
        ON sensor.vfd_parameter_audit_logs ("tenant_id", "vfd_device_id", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_vfd_param_audit_change_set"
        ON sensor.vfd_parameter_audit_logs ("change_set_id");
    `);
  }

  private async createPlcTelemetryTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.plc_telemetry (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "plcConnectionId" varchar NOT NULL,
        "tankId" varchar,
        "timestamp" timestamp NOT NULL,
        "sensors" jsonb NOT NULL,
        "actuators" jsonb NOT NULL,
        "feeding" jsonb NOT NULL,
        "plcStatus" jsonb NOT NULL,
        "activeParameterId" varchar,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_plc_telemetry_tenant_conn_ts"
        ON sensor.plc_telemetry ("tenant_id", "plcConnectionId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_plc_telemetry_tenant_id"
        ON sensor.plc_telemetry ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_plc_telemetry_timestamp"
        ON sensor.plc_telemetry ("timestamp");
    `);
  }

  private async createPlcAlarmsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.plc_alarms (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "plcConnectionId" varchar NOT NULL,
        "tankId" varchar,
        "alarmCode" varchar NOT NULL,
        "severity" varchar NOT NULL,
        "source" varchar NOT NULL,
        "message" varchar NOT NULL,
        "value" decimal(10, 4),
        "threshold" decimal(10, 4),
        "action" varchar,
        "timestamp" timestamp NOT NULL,
        "acknowledged" boolean NOT NULL DEFAULT false,
        "acknowledgedAt" timestamp,
        "acknowledgedBy" varchar,
        "clearedAt" timestamp,
        "notes" varchar,
        "approval_level" integer NOT NULL DEFAULT 0,
        "required_approval_level" integer NOT NULL DEFAULT 1,
        "approval_chain" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "escalated_at" timestamptz,
        "auto_escalate_after_ms" integer,
        "sla_deadline" timestamptz,
        "sla_breached" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_plc_alarms_tenant_conn_ts"
        ON sensor.plc_alarms ("tenant_id", "plcConnectionId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_plc_alarms_tenant_acknowledged"
        ON sensor.plc_alarms ("tenant_id", "acknowledged");
      CREATE INDEX IF NOT EXISTS "IDX_plc_alarms_tenant_id"
        ON sensor.plc_alarms ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_plc_alarms_timestamp"
        ON sensor.plc_alarms ("timestamp");
    `);
  }

  private async createDeviceEventsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.device_events (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "device_id" uuid,
        "event_type" sensor.device_events_event_type_enum NOT NULL,
        "severity" sensor.device_events_severity_enum NOT NULL DEFAULT 'info',
        "message" text NOT NULL,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_device_events_tenant_device"
        ON sensor.device_events ("tenant_id", "device_id");
      CREATE INDEX IF NOT EXISTS "IDX_device_events_tenant_event_type"
        ON sensor.device_events ("tenant_id", "event_type");
      CREATE INDEX IF NOT EXISTS "IDX_device_events_created_at"
        ON sensor.device_events ("created_at");
    `);
  }

  private async createDeploymentLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.deployment_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "program_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "command_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "status" sensor.deployment_logs_status_enum NOT NULL DEFAULT 'pending',
        "edge_script" jsonb,
        "deployed_by" varchar,
        "deployed_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completed_at" timestamptz,
        "edge_ack_at" timestamptz,
        "error_message" text,
        "updated_at" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "IDX_deployment_logs_tenant_device"
        ON sensor.deployment_logs ("tenant_id", "device_id");
      CREATE INDEX IF NOT EXISTS "IDX_deployment_logs_tenant_program"
        ON sensor.deployment_logs ("tenant_id", "program_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_deployment_logs_command_id"
        ON sensor.deployment_logs ("command_id");
    `);
  }

  private async alignProgramStepsColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "step_code" varchar(30) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "entry_action" text
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "exit_action" text
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "timeout_ms" integer
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "on_timeout" sensor.program_steps_on_timeout_enum
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "timeout_target_step" varchar(30)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_steps
        ADD COLUMN IF NOT EXISTS "step_order" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_program_steps_program_step_code"
        ON sensor.program_steps ("program_id", "step_code")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_program_steps_program_step_type"
        ON sensor.program_steps ("program_id", "step_type")
    `);
  }

  private async alignProgramTransitionsColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "transition_code" varchar(30) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "from_step_code" varchar(30)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "to_step_code" varchar(30)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "condition_type" sensor.program_transitions_condition_type_enum NOT NULL DEFAULT 'expression'
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "transpiled_condition" text
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "control_points" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "timeout_ms" integer
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "event_type" varchar(50)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_transitions
        ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_program_transitions_program_trans_code"
        ON sensor.program_transitions ("program_id", "transition_code")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_program_transitions_program_from"
        ON sensor.program_transitions ("program_id", "from_step_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_program_transitions_program_to"
        ON sensor.program_transitions ("program_id", "to_step_id")
    `);
  }

  private async alignProgramVariablesColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "var_name" varchar(50) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "display_name" varchar(100)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "io_config_id" varchar
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "io_tag_name" varchar(50)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "equipment_node_id" varchar(100)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "equipment_property" varchar(50)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "sensor_channel_id" varchar
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "min_value" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "max_value" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "eng_unit" varchar(20)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "alarm_hh" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "alarm_h" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "alarm_l" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "alarm_ll" decimal(15, 4)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.program_variables
        ADD COLUMN IF NOT EXISTS "var_order" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_program_variables_program_var_name"
        ON sensor.program_variables ("program_id", "var_name")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_program_variables_program_scope"
        ON sensor.program_variables ("program_id", "scope")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_program_variables_io_config"
        ON sensor.program_variables ("io_config_id")
    `);
  }

  private async alignStepActionsColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "action_type" sensor.step_actions_action_type_enum NOT NULL DEFAULT 'custom_st'
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "action_code" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "target_ref" varchar(100)
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "params" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "delay_ms" integer
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "action_order" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.step_actions
        ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true
    `);
  }
}
