import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateWelfareAssessments1802900000000
 *
 * Structured welfare scoring (RPT-010): gill/fin/wound/deformity 0–3 over a
 * fish sample, per tank per date. Welfare varsling and internal trends
 * consume these instead of free-string symptom arrays.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateWelfareAssessments1802900000000 implements MigrationInterface {
  name = 'CreateWelfareAssessments1802900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "welfare_assessments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "tankId" uuid NOT NULL,
        "batchId" uuid,
        "assessedAt" date NOT NULL,
        "fishSampled" integer NOT NULL,
        "gillScore" smallint NOT NULL,
        "finScore" smallint NOT NULL,
        "woundScore" smallint NOT NULL,
        "deformityScore" smallint NOT NULL,
        "assessedBy" uuid,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_welfare_assessments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_welfare_assessments_tenant_site_date"
        ON "welfare_assessments" ("tenantId", "siteId", "assessedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_welfare_assessments_tenant_tank_date"
        ON "welfare_assessments" ("tenantId", "tankId", "assessedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_welfare_assessments_tenant"
        ON "welfare_assessments" ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "welfare_assessments"`);
  }
}
