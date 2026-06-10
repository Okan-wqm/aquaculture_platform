import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillTenantFarmOperationalTables1800100000000
 *
 * Tenant fan-out migration for tables that landed in the source baseline after
 * some tenant schemas already existed. All DDL is tenant-relative: db-migrate
 * pins search_path to either `farm` or `tenant_<id>` before invoking this class.
 */
export class BackfillTenantFarmOperationalTables1800100000000
  implements MigrationInterface
{
  name = 'BackfillTenantFarmOperationalTables1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regtype(current_schema() || '.storage_lot_mixes_itemtype_enum') IS NULL THEN
          CREATE TYPE storage_lot_mixes_itemtype_enum AS ENUM (
            'feed',
            'chemical',
            'consumable',
            'healthcare'
          );
        END IF;

        IF to_regtype(current_schema() || '.biomass_reports_status_enum') IS NULL THEN
          CREATE TYPE biomass_reports_status_enum AS ENUM ('DRAFT', 'SUBMITTED');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS storage_lot_mixes (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "storageLocationId" uuid NOT NULL,
        "itemType" storage_lot_mixes_itemtype_enum NOT NULL,
        "itemId" uuid NOT NULL,
        "effectiveLotNumber" character varying(255) NOT NULL,
        "contributingLots" jsonb NOT NULL,
        "totalQuantityKg" numeric(14,2) NOT NULL,
        "mixedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_lot_mixes_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant"
         ON storage_lot_mixes ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_lot"
         ON storage_lot_mixes ("tenantId", "effectiveLotNumber")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_item"
         ON storage_lot_mixes ("tenantId", "itemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_location"
         ON storage_lot_mixes ("tenantId", "storageLocationId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS biomass_reports (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "reportMonth" integer NOT NULL,
        "reportYear" integer NOT NULL,
        "status" biomass_reports_status_enum NOT NULL DEFAULT 'DRAFT',
        "reportData" jsonb NOT NULL,
        "totalBiomassKg" numeric(14,2) NOT NULL DEFAULT '0',
        "generatedBy" uuid,
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        "submittedBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_biomass_reports_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_biomass_report_period"
          UNIQUE ("tenantId", "siteId", "reportMonth", "reportYear")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_biomass_reports_tenant"
         ON biomass_reports ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_biomass_reports_tenant_site_year"
         ON biomass_reports ("tenantId", "siteId", "reportYear")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_biomass_reports_tenant_status"
         ON biomass_reports ("tenantId", "status")`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ missing: string }> = await queryRunner.query(`
      SELECT table_name AS missing
        FROM (VALUES ('storage_lot_mixes'), ('biomass_reports')) AS expected(table_name)
       WHERE NOT EXISTS (
         SELECT 1
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name = expected.table_name
       )
    `);
    return rows.length === 0;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS biomass_reports`);
    await queryRunner.query(`DROP TABLE IF EXISTS storage_lot_mixes`);
    await queryRunner.query(`DROP TYPE IF EXISTS biomass_reports_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS storage_lot_mixes_itemtype_enum`);
  }
}
