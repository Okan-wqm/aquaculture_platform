import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'regulatory_reports';

/**
 * FARM-HIGH-125 — persistent record for every Mattilsynet report submission.
 * Before this table the seven non-biomass report types were fired at the
 * regulator with no local row; the frontend report-history tabs rendered
 * mock data because there was nothing real to list.
 */
export class CreateRegulatoryReports1801900000000 implements MigrationInterface {
  name = 'CreateRegulatoryReports1801900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureEnums(queryRunner);
    await this.ensureTable(queryRunner);
    await this.ensureIndexes(queryRunner);

    await applyTenantRlsToSchema(queryRunner, {
      includeTables: [TABLE],
      tenantIdColumns: ['tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${TABLE}') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = '${TABLE}'
            AND column_name = 'klientReferanse'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'UQ_regulatory_report_client_ref'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = '${TABLE}'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only SSOT migration. Regulatory submission records are the
    // legal audit trail of what was reported to Mattilsynet — never drop.
  }

  private async ensureEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE regulatory_reports_type_enum AS ENUM (
          'SEA_LICE',
          'CLEANER_FISH',
          'SMOLT',
          'SLAUGHTER_PLANNED',
          'SLAUGHTER_EXECUTED',
          'WELFARE_EVENT',
          'ESCAPE',
          'DISEASE_OUTBREAK'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE regulatory_reports_status_enum AS ENUM (
          'PENDING',
          'SUBMITTED',
          'QUEUED',
          'FAILED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  private async ensureTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "reportType" regulatory_reports_type_enum NOT NULL,
        "klientReferanse" VARCHAR(128) NOT NULL,
        "siteId" UUID NULL,
        "lokalitetsnummer" INTEGER NOT NULL,
        "reportYear" INTEGER NULL,
        "reportWeek" INTEGER NULL,
        "reportMonth" INTEGER NULL,
        "status" regulatory_reports_status_enum NOT NULL DEFAULT 'PENDING',
        "payload" JSONB NOT NULL,
        "referanse" VARCHAR(255) NULL,
        "feilmelding" TEXT NULL,
        "submittedBy" UUID NOT NULL,
        "submittedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async ensureIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_regulatory_report_client_ref"
        ON ${TABLE} ("tenantId", "reportType", "klientReferanse")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_regulatory_reports_tenant_type_year"
        ON ${TABLE} ("tenantId", "reportType", "reportYear")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_regulatory_reports_tenant_status"
        ON ${TABLE} ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_regulatory_reports_tenant_site"
        ON ${TABLE} ("tenantId", "siteId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_regulatory_reports_tenant_id"
        ON ${TABLE} ("tenantId")
    `);
  }
}
