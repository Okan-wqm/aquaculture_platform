import { MigrationInterface, QueryRunner } from 'typeorm';

const PROJECTION_REBUILDS_RLS_POLICY = `
  current_setting('app.bypass_rls', true) = 'on'
  OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
`;

export class ProjectionRebuilds1800200000000 implements MigrationInterface {
  name = 'ProjectionRebuilds1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_store"."projection_rebuilds" (
        "jobId" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "projectionName" character varying(255) NOT NULL,
        "requestedFromPosition" bigint NOT NULL,
        "sourceGeneration" integer NOT NULL,
        "targetGeneration" integer NOT NULL,
        "leaseToken" uuid,
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
        "status" character varying(40) NOT NULL DEFAULT 'requested',
        "requestedBy" character varying(255),
        "reason" text NOT NULL,
        "correlationId" uuid,
        "idempotencyKey" character varying(255),
        "leasedAt" TIMESTAMP WITH TIME ZONE,
        "buildStartedAt" TIMESTAMP WITH TIME ZONE,
        "validatedAt" TIMESTAMP WITH TIME ZONE,
        "caughtUpAt" TIMESTAMP WITH TIME ZONE,
        "swappedAt" TIMESTAMP WITH TIME ZONE,
        "releasedAt" TIMESTAMP WITH TIME ZONE,
        "validationHash" character varying(128),
        "validationCount" bigint,
        "abortReason" text,
        "failureReason" text,
        "requestedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projection_rebuilds" PRIMARY KEY ("jobId"),
        CONSTRAINT "CHK_projection_rebuilds_status" CHECK (
          "status" IN (
            'requested',
            'leased',
            'building_shadow',
            'validating',
            'catching_up',
            'swapping',
            'completed',
            'aborted',
            'failed'
          )
        ),
        CONSTRAINT "CHK_projection_rebuilds_requested_position" CHECK ("requestedFromPosition" >= 0),
        CONSTRAINT "CHK_projection_rebuilds_generation" CHECK ("targetGeneration" > "sourceGeneration")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_projection_rebuilds_tenant_projection_status"
      ON "event_store"."projection_rebuilds" ("tenantId", "projectionName", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_projection_rebuilds_lease"
      ON "event_store"."projection_rebuilds" ("tenantId", "projectionName", "leaseToken")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projection_rebuilds_one_active_job"
      ON "event_store"."projection_rebuilds" ("tenantId", "projectionName")
      WHERE "status" IN (
        'requested',
        'leased',
        'building_shadow',
        'validating',
        'catching_up',
        'swapping'
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projection_rebuilds_idempotency"
      ON "event_store"."projection_rebuilds" ("tenantId", "projectionName", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_rebuilds" ENABLE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_rebuilds" FORCE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "tenant_isolation_policy"
      ON "event_store"."projection_rebuilds"
    `);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation_policy"
      ON "event_store"."projection_rebuilds"
      USING (${PROJECTION_REBUILDS_RLS_POLICY})
      WITH CHECK (${PROJECTION_REBUILDS_RLS_POLICY})
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP POLICY IF EXISTS "tenant_isolation_policy"
      ON "event_store"."projection_rebuilds"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_projection_rebuilds_idempotency"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_projection_rebuilds_lease"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_projection_rebuilds_one_active_job"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_projection_rebuilds_tenant_projection_status"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "event_store"."projection_rebuilds"
    `);
  }
}
