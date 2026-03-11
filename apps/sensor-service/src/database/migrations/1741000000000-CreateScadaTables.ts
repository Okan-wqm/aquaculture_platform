import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the SCADA tables in the sensor schema:
 *   - scada_packages: stores SCADA HMI packages (screens, alarms, controls, trends)
 *   - scada_deploy_logs: tracks deployment lifecycle of packages to edge devices
 *   - unified_tags: unified tag database for SCADA/PLC I/O points
 */
export class CreateScadaTables1741000000000 implements MigrationInterface {
  name = 'CreateScadaTables1741000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── scada_packages ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_packages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        version INT NOT NULL DEFAULT 1,
        process_id UUID,
        package_data JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        created_by VARCHAR(255),
        updated_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_packages_tenant_status"
      ON sensor.scada_packages (tenant_id, status)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_packages_tenant_id"
      ON sensor.scada_packages (tenant_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_packages_process_id"
      ON sensor.scada_packages (process_id)
    `);

    // ── scada_deploy_logs ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_deploy_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        package_id UUID NOT NULL,
        device_id UUID NOT NULL,
        command_id UUID NOT NULL,
        version INT NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        sent_at TIMESTAMP WITH TIME ZONE,
        received_at TIMESTAMP WITH TIME ZONE,
        deployed_at TIMESTAMP WITH TIME ZONE,
        verified_at TIMESTAMP WITH TIME ZONE,
        health_check_results JSONB,
        error_message TEXT,
        rolled_back_to INT,
        deployed_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_scada_deploy_logs_tenant_command"
      ON sensor.scada_deploy_logs (tenant_id, command_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_deploy_logs_tenant_device"
      ON sensor.scada_deploy_logs (tenant_id, device_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_deploy_logs_tenant_package"
      ON sensor.scada_deploy_logs (tenant_id, package_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_deploy_logs_command_id"
      ON sensor.scada_deploy_logs (command_id)
    `);

    // ── unified_tags ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.unified_tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        fqn VARCHAR(500) NOT NULL,
        local_name VARCHAR(255),
        display_name VARCHAR(255),
        description TEXT,
        io_type VARCHAR(50),
        data_type VARCHAR(50),
        direction VARCHAR(50),
        eng_unit VARCHAR(50),
        eng_min DOUBLE PRECISION,
        eng_max DOUBLE PRECISION,
        alarm_hh DOUBLE PRECISION,
        alarm_h DOUBLE PRECISION,
        alarm_l DOUBLE PRECISION,
        alarm_ll DOUBLE PRECISION,
        deadband DOUBLE PRECISION,
        source JSONB,
        hierarchy JSONB,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_unified_tags_tenant_fqn"
      ON sensor.unified_tags (tenant_id, fqn)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_unified_tags_tenant_id"
      ON sensor.unified_tags (tenant_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.unified_tags`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.scada_deploy_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.scada_packages`);
  }
}
