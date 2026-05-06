import { MigrationInterface, QueryRunner } from 'typeorm';

import { MigrationLogger, assertSafeSchemaName } from '@aquaculture/backend-common/database';

export class AddBiomassReports1788300000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddBiomassReports1788300000000');
  name = 'AddBiomassReports1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await this.tableExistsInSchema(queryRunner, 'farm', 'biomass_reports');

    if (!tableExists) {
      await queryRunner.query(`
        CREATE TABLE "farm"."biomass_reports" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenantId" UUID NOT NULL,
          "siteId" UUID NOT NULL,
          "reportMonth" INTEGER NOT NULL,
          "reportYear" INTEGER NOT NULL,
          "status" VARCHAR NOT NULL DEFAULT 'draft',
          "reportData" JSONB NOT NULL,
          "totalBiomassKg" NUMERIC(14, 2) NOT NULL DEFAULT 0,
          "generatedBy" UUID,
          "submittedAt" TIMESTAMPTZ,
          "submittedBy" UUID,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "UQ_biomass_report_period"
            UNIQUE ("tenantId", "siteId", "reportMonth", "reportYear")
        );
        CREATE INDEX "IDX_biomass_reports_tenant_status"
        ON "farm"."biomass_reports" ("tenantId", "status");
        CREATE INDEX "IDX_biomass_reports_tenant_site_year"
        ON "farm"."biomass_reports" ("tenantId", "siteId", "reportYear");
        CREATE INDEX "IDX_biomass_reports_tenant_id"
        ON "farm"."biomass_reports" ("tenantId")
      `);
      this.logger.log('Created biomass_reports table in farm schema');
    } else {
      this.logger.log('biomass_reports table already exists in farm schema, skipping');
    }

    const tenantSchemas = await this.listTenantSchemas(queryRunner);
    for (const schemaName of tenantSchemas) {
      assertSafeSchemaName(schemaName);
      const tenantTableExists = await this.tableExistsInSchema(
        queryRunner,
        schemaName,
        'biomass_reports',
      );
      if (tenantTableExists) {
        this.logger.log(`biomass_reports already exists in ${schemaName}, skipping`);
        continue;
      }
      await queryRunner.query(`
        CREATE TABLE "${schemaName}"."biomass_reports"
        (LIKE "farm"."biomass_reports" INCLUDING ALL)
      `);
      this.logger.log(`Created biomass_reports in ${schemaName}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tenantSchemas = await this.listTenantSchemas(queryRunner);
    for (const schemaName of tenantSchemas) {
      assertSafeSchemaName(schemaName);
      await queryRunner.query(`DROP TABLE IF EXISTS "${schemaName}"."biomass_reports"`);
      this.logger.log(`Dropped biomass_reports from ${schemaName}`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "farm"."biomass_reports"`);
    this.logger.log('Dropped biomass_reports from farm schema');
  }

  private async listTenantSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await queryRunner.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);

    return rows.map((row) => row.schema_name);
  }

  private async tableExistsInSchema(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = $2
        ) AS exists
      `,
      [schemaName, tableName],
    );

    return rows[0]?.exists === true;
  }
}
