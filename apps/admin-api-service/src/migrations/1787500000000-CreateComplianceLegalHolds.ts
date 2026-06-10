import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateComplianceLegalHolds1787500000000 implements MigrationInterface {
  name = 'CreateComplianceLegalHolds1787500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "compliance"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "compliance"."legal_holds" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "scope" varchar(32) NOT NULL,
        "resourceId" uuid NULL,
        "reason" text NOT NULL,
        "legalMatterId" varchar(128) NOT NULL,
        "appliedBy" uuid NOT NULL,
        "appliedAt" timestamptz NOT NULL DEFAULT NOW(),
        "releasedBy" uuid NULL,
        "releasedAt" timestamptz NULL,
        "releaseReason" text NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_legal_hold_active"
        ON "compliance"."legal_holds" ("tenantId", "scope", "resourceId", "releasedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_legal_hold_legal_matter"
        ON "compliance"."legal_holds" ("legalMatterId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_legal_hold_active_per_resource"
        ON "compliance"."legal_holds" ("tenantId", "scope", "resourceId")
        WHERE "releasedAt" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "compliance"."UQ_legal_hold_active_per_resource"');
    await queryRunner.query('DROP INDEX IF EXISTS "compliance"."IDX_legal_hold_legal_matter"');
    await queryRunner.query('DROP INDEX IF EXISTS "compliance"."IDX_legal_hold_active"');
    await queryRunner.query('DROP TABLE IF EXISTS "compliance"."legal_holds"');
  }
}
