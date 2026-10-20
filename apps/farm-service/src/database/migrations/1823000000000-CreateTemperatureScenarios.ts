import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the production-plan temperature scenario tables (per-tenant).
 *
 * Tenant-relative: db-migrate pins search_path to `farm` or `tenant_<id>`
 * before this runs. The `farm` source schema also owns these tables (the
 * tenant provisioning template copies them), so the DDL runs unconditionally
 * and is idempotent via IF NOT EXISTS.
 */
export class CreateTemperatureScenarios1823000000000 implements MigrationInterface {
  name = 'CreateTemperatureScenarios1823000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "temperature_scenarios" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "source" character varying(20) NOT NULL DEFAULT 'manual',
        "isDeleted" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CONSTRAINT "PK_temperature_scenarios" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_temperature_scenarios_tenant_site" ON "temperature_scenarios" ("tenantId", "siteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_temperature_scenarios_tenant_deleted" ON "temperature_scenarios" ("tenantId", "isDeleted")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "temperature_scenario_points" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "scenarioId" uuid NOT NULL,
        "date" date NOT NULL,
        "celsius" real NOT NULL,
        CONSTRAINT "PK_temperature_scenario_points" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_temperature_scenario_points_lookup"
         ON "temperature_scenario_points" ("tenantId", "scenarioId", "date")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_temperature_scenario_points_scenario'
            AND conrelid = 'temperature_scenario_points'::regclass
        ) THEN
          ALTER TABLE "temperature_scenario_points"
          ADD CONSTRAINT "FK_temperature_scenario_points_scenario"
          FOREIGN KEY ("scenarioId") REFERENCES "temperature_scenarios"("id") ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $$;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "temperature_scenario_points"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "temperature_scenarios"`);
  }
}
