import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateEscapeIncidents1803000000000
 *
 * Operational escape-incident records (RPT-009): the rømming varsling
 * previously had nothing to reconcile against. The varsling form assembles
 * from these and links back via varslingReportId once submitted.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateEscapeIncidents1803000000000 implements MigrationInterface {
  name = 'CreateEscapeIncidents1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE escape_incidents_cause_enum AS ENUM (
          'hole_in_net', 'handling', 'predator', 'structural_failure',
          'operational', 'unknown', 'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE escape_incidents_status_enum AS ENUM ('open', 'closed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "escape_incidents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "tankId" uuid,
        "batchId" uuid,
        "detectedAt" timestamptz NOT NULL,
        "speciesId" uuid NOT NULL,
        "estimatedCount" integer NOT NULL,
        "avgWeightG" numeric(8,1),
        "cause" escape_incidents_cause_enum NOT NULL DEFAULT 'unknown',
        "causeDetails" text,
        "recoveryOngoing" boolean NOT NULL DEFAULT false,
        "recoveredCount" integer,
        "status" escape_incidents_status_enum NOT NULL DEFAULT 'open',
        "varslingReportId" uuid,
        "createdBy" uuid,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_escape_incidents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_escape_incidents_tenant_site_detected"
        ON "escape_incidents" ("tenantId", "siteId", "detectedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_escape_incidents_tenant_status"
        ON "escape_incidents" ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_escape_incidents_tenant"
        ON "escape_incidents" ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "escape_incidents"`);
    await queryRunner.query(`DROP TYPE IF EXISTS escape_incidents_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS escape_incidents_cause_enum`);
  }
}
