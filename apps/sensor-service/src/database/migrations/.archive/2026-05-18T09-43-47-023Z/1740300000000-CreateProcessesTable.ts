import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the 'processes' table in the sensor schema.
 *
 * The Process entity was added but no migration existed to create the table,
 * causing "relation 'processes' does not exist" errors in production
 * (DATABASE_SYNC is disabled).
 */
export class CreateProcessesTable1740300000000 implements MigrationInterface {
  name = 'CreateProcessesTable1740300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type for process status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.process_status AS ENUM ('draft', 'active', 'inactive', 'archived');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Create processes table in sensor schema
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.processes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        code VARCHAR(255) NOT NULL,
        description TEXT,
        status sensor.process_status NOT NULL DEFAULT 'draft',
        nodes JSONB NOT NULL DEFAULT '[]',
        edges JSONB NOT NULL DEFAULT '[]',
        tenant_id UUID NOT NULL,
        site_id VARCHAR(255),
        department_id VARCHAR(255),
        metadata JSONB,
        is_template BOOLEAN NOT NULL DEFAULT false,
        template_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        created_by VARCHAR(255),
        updated_by VARCHAR(255)
      )
    `);

    // Create indexes matching @Index decorators on the entity
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_processes_tenant_status"
      ON sensor.processes (tenant_id, status)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_processes_tenant_site"
      ON sensor.processes (tenant_id, site_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_processes_tenant_id"
      ON sensor.processes (tenant_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_processes_site_id"
      ON sensor.processes (site_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.processes`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.process_status`);
  }
}
