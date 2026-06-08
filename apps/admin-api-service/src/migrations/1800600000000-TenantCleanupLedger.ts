import { MigrationInterface, QueryRunner } from 'typeorm';

export class TenantCleanupLedger1800600000000 implements MigrationInterface {
  name = 'TenantCleanupLedger1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."cleanup_runs" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "scope" VARCHAR(50) NOT NULL DEFAULT 'tenant',
        "actorUserId" VARCHAR(128) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
        "legalHoldCheckedAt" TIMESTAMPTZ NULL,
        "backupId" UUID NULL,
        "backupChecksum" VARCHAR(64) NULL,
        "backupSizeBytes" BIGINT NULL,
        "backupEncrypted" BOOLEAN NOT NULL DEFAULT false,
        "preCounts" JSONB NOT NULL DEFAULT '{}',
        "postCounts" JSONB NULL,
        "error" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMPTZ NULL,
        CONSTRAINT "chk_cleanup_runs_status"
          CHECK ("status" IN ('RUNNING', 'PENDING_DB_MIGRATE', 'SUCCEEDED', 'FAILED', 'DENIED')),
        CONSTRAINT "chk_cleanup_runs_scope"
          CHECK ("scope" IN ('tenant')),
        CONSTRAINT "fk_cleanup_runs_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "auth"."tenants"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_cleanup_runs_backup"
          FOREIGN KEY ("backupId") REFERENCES "admin"."schema_backups"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."cleanup_runs"
        DROP CONSTRAINT IF EXISTS "fk_cleanup_runs_backup"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "admin"."cleanup_runs"
          ADD CONSTRAINT "fk_cleanup_runs_backup"
            FOREIGN KEY ("backupId") REFERENCES "admin"."schema_backups"("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cleanup_runs_tenant_created"
        ON "admin"."cleanup_runs" ("tenantId", "createdAt" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cleanup_runs_status"
        ON "admin"."cleanup_runs" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."cleanup_run_steps" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "runId" UUID NOT NULL,
        "stepName" VARCHAR(100) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "error" TEXT NULL,
        "startedAt" TIMESTAMPTZ NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_cleanup_run_steps_status"
          CHECK ("status" IN ('pending', 'in_progress', 'completed', 'failed')),
        CONSTRAINT "fk_cleanup_run_steps_run"
          FOREIGN KEY ("runId") REFERENCES "admin"."cleanup_runs"("id") ON DELETE RESTRICT,
        CONSTRAINT "uk_cleanup_run_steps_run_step" UNIQUE ("runId", "stepName")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."cleanup_run_steps"
        DROP CONSTRAINT IF EXISTS "fk_cleanup_run_steps_run"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "admin"."cleanup_run_steps"
          ADD CONSTRAINT "fk_cleanup_run_steps_run"
            FOREIGN KEY ("runId") REFERENCES "admin"."cleanup_runs"("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cleanup_run_steps_run"
        ON "admin"."cleanup_run_steps" ("runId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."cleanup_run_events" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "runId" UUID NOT NULL,
        "eventType" VARCHAR(100) NOT NULL,
        "payload" JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "fk_cleanup_run_events_run"
          FOREIGN KEY ("runId") REFERENCES "admin"."cleanup_runs"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."cleanup_run_evidence" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "runId" UUID NOT NULL,
        "evidenceType" VARCHAR(100) NOT NULL,
        "evidenceHash" VARCHAR(64) NOT NULL,
        "payload" JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "fk_cleanup_run_evidence_run"
          FOREIGN KEY ("runId") REFERENCES "admin"."cleanup_runs"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cleanup_run_events_run"
        ON "admin"."cleanup_run_events" ("runId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cleanup_run_evidence_run"
        ON "admin"."cleanup_run_evidence" ("runId", "createdAt")
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin"."reject_cleanup_worm_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'cleanup WORM rows are append-only';
      END;
      $$;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_cleanup_run_events_worm" ON "admin"."cleanup_run_events";
      CREATE TRIGGER "trg_cleanup_run_events_worm"
        BEFORE UPDATE OR DELETE ON "admin"."cleanup_run_events"
        FOR EACH ROW EXECUTE FUNCTION "admin"."reject_cleanup_worm_mutation"();
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_cleanup_run_evidence_worm" ON "admin"."cleanup_run_evidence";
      CREATE TRIGGER "trg_cleanup_run_evidence_worm"
        BEFORE UPDATE OR DELETE ON "admin"."cleanup_run_evidence"
        FOR EACH ROW EXECUTE FUNCTION "admin"."reject_cleanup_worm_mutation"();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_cleanup_run_evidence_worm" ON "admin"."cleanup_run_evidence"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_cleanup_run_events_worm" ON "admin"."cleanup_run_events"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "admin"."reject_cleanup_worm_mutation"');
    await queryRunner.query('DROP TABLE IF EXISTS "admin"."cleanup_run_evidence"');
    await queryRunner.query('DROP TABLE IF EXISTS "admin"."cleanup_run_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "admin"."cleanup_run_steps"');
    await queryRunner.query('DROP TABLE IF EXISTS "admin"."cleanup_runs"');
  }
}
