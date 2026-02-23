import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates automation-related tables in the sensor schema.
 *
 * Tables: automation_programs, program_steps, step_actions,
 *         program_transitions, program_variables
 *
 * These entities existed but had no migration, causing
 * "relation does not exist" errors in production.
 */
export class CreateAutomationTables1740300001000 implements MigrationInterface {
  name = 'CreateAutomationTables1740300001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.program_type AS ENUM ('SFC', 'ST', 'LD', 'FBD', 'IL', 'HYBRID');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.program_status AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'DEPLOYED', 'RUNNING', 'STOPPED', 'ERROR', 'ARCHIVED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.execution_mode AS ENUM ('MANUAL', 'AUTOMATIC', 'SCHEDULED', 'EVENT_DRIVEN');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.deploy_target AS ENUM ('SIMULATION', 'NODE_RED', 'PLC_CODESYS', 'PLC_OPCUA', 'RUST_ENGINE', 'EDGE_DEVICE');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.step_type AS ENUM ('INITIAL', 'NORMAL', 'MACRO', 'ENCLOSING', 'EXCEPTION');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.action_qualifier AS ENUM ('N', 'R', 'S', 'L', 'D', 'P', 'SD', 'DS', 'SL', 'P0', 'P1');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.variable_scope AS ENUM ('INPUT', 'OUTPUT', 'IN_OUT', 'LOCAL', 'GLOBAL', 'TEMP', 'RETAIN');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.variable_data_type AS ENUM ('BOOL', 'INT', 'REAL', 'STRING', 'TIME', 'DATE', 'DINT', 'UINT', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'ARRAY', 'STRUCT');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // automation_programs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.automation_programs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        device_id VARCHAR(255),
        process_template_id VARCHAR(255),
        program_code VARCHAR(30) NOT NULL,
        program_name VARCHAR(100) NOT NULL,
        description TEXT,
        program_type sensor.program_type NOT NULL DEFAULT 'SFC',
        category VARCHAR(50),
        sfc_definition JSONB NOT NULL DEFAULT '{}',
        structured_text_code TEXT,
        transpiled_js TEXT,
        execution_mode sensor.execution_mode NOT NULL DEFAULT 'MANUAL',
        scan_cycle_ms INT NOT NULL DEFAULT 100,
        priority INT NOT NULL DEFAULT 5,
        trigger_config JSONB,
        version INT NOT NULL DEFAULT 1,
        status sensor.program_status NOT NULL DEFAULT 'DRAFT',
        deployed_version INT,
        deployed_at TIMESTAMPTZ,
        deployed_by VARCHAR(255),
        approved_at TIMESTAMPTZ,
        approved_by VARCHAR(255),
        is_locked BOOLEAN NOT NULL DEFAULT false,
        locked_by VARCHAR(255),
        locked_at TIMESTAMPTZ,
        deploy_target sensor.deploy_target NOT NULL DEFAULT 'RUST_ENGINE',
        target_plc_address VARCHAR(100),
        target_plc_port INT,
        target_plc_model VARCHAR(100),
        target_plc_protocol VARCHAR(50),
        tags JSONB,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by VARCHAR(255)
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_programs_tenant_device" ON sensor.automation_programs (tenant_id, device_id)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automation_programs_tenant_code" ON sensor.automation_programs (tenant_id, program_code)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_programs_tenant_status" ON sensor.automation_programs (tenant_id, status)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_programs_tenant_id" ON sensor.automation_programs (tenant_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_programs_device_id" ON sensor.automation_programs (device_id)`);

    // program_steps
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.program_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES sensor.automation_programs(id) ON DELETE CASCADE,
        step_name VARCHAR(50) NOT NULL,
        step_type sensor.step_type NOT NULL DEFAULT 'NORMAL',
        "order" INT NOT NULL DEFAULT 0,
        description TEXT,
        time_limit_ms INT,
        position_x FLOAT,
        position_y FLOAT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_program_steps_program_id" ON sensor.program_steps (program_id)`);

    // step_actions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.step_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        step_id UUID NOT NULL REFERENCES sensor.program_steps(id) ON DELETE CASCADE,
        action_name VARCHAR(50) NOT NULL,
        qualifier sensor.action_qualifier NOT NULL DEFAULT 'N',
        "order" INT NOT NULL DEFAULT 0,
        action_body TEXT,
        duration_ms INT,
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_step_actions_step_id" ON sensor.step_actions (step_id)`);

    // program_transitions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.program_transitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES sensor.automation_programs(id) ON DELETE CASCADE,
        from_step_id UUID NOT NULL REFERENCES sensor.program_steps(id) ON DELETE CASCADE,
        to_step_id UUID NOT NULL REFERENCES sensor.program_steps(id) ON DELETE CASCADE,
        transition_name VARCHAR(50),
        condition_expression TEXT NOT NULL,
        priority INT NOT NULL DEFAULT 0,
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_program_transitions_program_id" ON sensor.program_transitions (program_id)`);

    // program_variables
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.program_variables (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES sensor.automation_programs(id) ON DELETE CASCADE,
        variable_name VARCHAR(50) NOT NULL,
        data_type sensor.variable_data_type NOT NULL DEFAULT 'BOOL',
        scope sensor.variable_scope NOT NULL DEFAULT 'LOCAL',
        initial_value VARCHAR(255),
        current_value VARCHAR(255),
        description TEXT,
        address VARCHAR(50),
        is_persistent BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_program_variables_program_id" ON sensor.program_variables (program_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.program_variables CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.step_actions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.program_transitions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.program_steps CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.automation_programs CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.variable_data_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.variable_scope`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.action_qualifier`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.step_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.deploy_target`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.execution_mode`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.program_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.program_type`);
  }
}
