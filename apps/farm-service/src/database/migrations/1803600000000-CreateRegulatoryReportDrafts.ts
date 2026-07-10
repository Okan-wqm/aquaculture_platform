import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateRegulatoryReportDrafts1803600000000
 *
 * The scheduler's unit of work (RPT-003): one draft per (tenant, reportType,
 * site, period), assembled on rollover and reviewed/approved for submission.
 *
 * One draft per period is enforced by a partial UNIQUE expression index using
 * COALESCE on the nullable week/month so the weekly and monthly grains share a
 * single constraint; rollover upserts with ON CONFLICT DO NOTHING.
 *
 * Also adds `regulatory_settings.auto_submit_policies` (opt-in per report type,
 * user decision) — jsonb defaulting to '{}'.
 *
 * current_schema-relative, idempotent, forward-only. The status enum is created
 * per-schema here (fresh type for a fresh per-tenant table), mirroring
 * CreateEscapeIncidents.
 */
export class CreateRegulatoryReportDrafts1803600000000 implements MigrationInterface {
  name = 'CreateRegulatoryReportDrafts1803600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE regulatory_report_drafts_status_enum AS ENUM (
          'draft', 'ready', 'approved', 'submitted', 'dismissed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "regulatory_report_drafts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "reportType" character varying(40) NOT NULL,
        "siteId" uuid NOT NULL,
        "periodYear" integer NOT NULL,
        "periodWeek" integer,
        "periodMonth" integer,
        "status" regulatory_report_drafts_status_enum NOT NULL DEFAULT 'draft',
        "assembledPayload" jsonb NOT NULL,
        "fieldMeta" jsonb NOT NULL,
        "manualOverrides" jsonb,
        "schemaValid" boolean NOT NULL DEFAULT false,
        "dueAt" date,
        "assembledAt" timestamptz NOT NULL,
        "submittedReportId" uuid,
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_regulatory_report_drafts" PRIMARY KEY ("id")
      )
    `);

    // One draft per (tenant, reportType, site, period) — COALESCE folds the two
    // nullable period grains into one deterministic key.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_regulatory_report_drafts_period"
        ON "regulatory_report_drafts" (
          "tenantId", "reportType", "siteId", "periodYear",
          COALESCE("periodWeek", 0), COALESCE("periodMonth", 0)
        )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_regulatory_report_drafts_tenant_status"
        ON "regulatory_report_drafts" ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_regulatory_report_drafts_tenant_type_site"
        ON "regulatory_report_drafts" ("tenantId", "reportType", "siteId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_regulatory_report_drafts_tenant"
        ON "regulatory_report_drafts" ("tenantId")
    `);

    await queryRunner.query(`
      ALTER TABLE "regulatory_settings"
        ADD COLUMN IF NOT EXISTS "auto_submit_policies" jsonb NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_settings" DROP COLUMN IF EXISTS "auto_submit_policies"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "regulatory_report_drafts"`);
    await queryRunner.query(`DROP TYPE IF EXISTS regulatory_report_drafts_status_enum`);
  }
}
