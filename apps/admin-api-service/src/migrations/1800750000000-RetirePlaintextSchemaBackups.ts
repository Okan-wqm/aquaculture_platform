import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Legacy backup rows with isEncrypted=false cannot be made safe inside a
 * database migration: db-migrate has no authority over historical dump files.
 * Move those records out of the active restore surface before the strict
 * encrypted-backups invariant is enforced by 180080.
 */
export class RetirePlaintextSchemaBackups1800750000000 implements MigrationInterface {
  name = 'RetirePlaintextSchemaBackups1800750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."retired_schema_backups" (
        "backupId" UUID PRIMARY KEY,
        "tenantId" UUID NULL,
        "schemaName" VARCHAR(100) NOT NULL,
        "backupType" VARCHAR(50) NOT NULL,
        "status" VARCHAR(50) NOT NULL,
        "filePath" VARCHAR(500) NULL,
        "fileName" VARCHAR(200) NULL,
        "sizeBytes" BIGINT NOT NULL DEFAULT 0,
        "checksum" VARCHAR(64) NULL,
        "isCompressed" BOOLEAN NOT NULL DEFAULT false,
        "retentionDays" INTEGER NOT NULL DEFAULT 0,
        "errorMessage" TEXT NULL,
        "metadata" JSONB NULL,
        "startedAt" TIMESTAMPTZ NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "expiresAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NULL,
        "retiredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "retiredReason" VARCHAR(100) NOT NULL,
        "retiredByMigration" VARCHAR(100) NOT NULL,
        "cleanupRunIds" UUID[] NOT NULL DEFAULT '{}',
        "restoreIds" UUID[] NOT NULL DEFAULT '{}',
        "originalRecord" JSONB NOT NULL,
        CONSTRAINT "chk_retired_schema_backups_reason"
          CHECK ("retiredReason" IN ('legacy_plaintext_backup'))
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.cleanup_runs') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = 'admin'
                AND table_name = 'cleanup_runs'
                AND column_name = 'retiredBackupId'
           )
        THEN
          ALTER TABLE "admin"."cleanup_runs"
            ADD COLUMN IF NOT EXISTS "retiredBackupId" UUID NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.schema_restores') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = 'admin'
                AND table_name = 'schema_restores'
                AND column_name = 'retiredBackupId'
           )
        THEN
          ALTER TABLE "admin"."schema_restores"
            ADD COLUMN IF NOT EXISTS "retiredBackupId" UUID NULL;
        END IF;

        IF to_regclass('admin.schema_restores') IS NOT NULL THEN
          ALTER TABLE "admin"."schema_restores"
            ALTER COLUMN "backupId" DROP NOT NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      INSERT INTO "admin"."retired_schema_backups" (
        "backupId",
        "tenantId",
        "schemaName",
        "backupType",
        "status",
        "filePath",
        "fileName",
        "sizeBytes",
        "checksum",
        "isCompressed",
        "retentionDays",
        "errorMessage",
        "metadata",
        "startedAt",
        "completedAt",
        "expiresAt",
        "createdAt",
        "retiredReason",
        "retiredByMigration",
        "cleanupRunIds",
        "restoreIds",
        "originalRecord"
      )
      SELECT
        b."id",
        b."tenantId",
        b."schemaName",
        b."backupType",
        b."status",
        b."filePath",
        b."fileName",
        b."sizeBytes",
        b."checksum",
        b."isCompressed",
        b."retentionDays",
        b."errorMessage",
        b."metadata",
        b."startedAt",
        b."completedAt",
        now(),
        b."createdAt",
        'legacy_plaintext_backup',
        'RetirePlaintextSchemaBackups1800750000000',
        COALESCE((
          SELECT array_agg(cr."id" ORDER BY cr."createdAt")
            FROM "admin"."cleanup_runs" cr
           WHERE cr."backupId" = b."id"
        ), ARRAY[]::UUID[]),
        COALESCE((
          SELECT array_agg(sr."id" ORDER BY sr."createdAt")
            FROM "admin"."schema_restores" sr
           WHERE sr."backupId" = b."id"
        ), ARRAY[]::UUID[]),
        to_jsonb(b)
      FROM "admin"."schema_backups" b
      WHERE b."isEncrypted" IS DISTINCT FROM true
      ON CONFLICT ("backupId") DO NOTHING
    `);

    await queryRunner.query(`
      UPDATE "admin"."retired_schema_backups" r
         SET "cleanupRunIds" = COALESCE((
           SELECT array_agg(DISTINCT linked_id ORDER BY linked_id)
             FROM unnest(
               r."cleanupRunIds" ||
               COALESCE((
                 SELECT array_agg(cr."id")
                   FROM "admin"."cleanup_runs" cr
                  WHERE cr."backupId" = r."backupId"
               ), ARRAY[]::UUID[])
             ) AS linked(linked_id)
         ), ARRAY[]::UUID[])
       WHERE EXISTS (
         SELECT 1
           FROM "admin"."schema_backups" b
          WHERE b."id" = r."backupId"
            AND b."isEncrypted" IS DISTINCT FROM true
       )
    `);

    await queryRunner.query(`
      UPDATE "admin"."retired_schema_backups" r
         SET "restoreIds" = COALESCE((
           SELECT array_agg(DISTINCT linked_id ORDER BY linked_id)
             FROM unnest(
               r."restoreIds" ||
               COALESCE((
                 SELECT array_agg(sr."id")
                   FROM "admin"."schema_restores" sr
                  WHERE sr."backupId" = r."backupId"
               ), ARRAY[]::UUID[])
             ) AS linked(linked_id)
         ), ARRAY[]::UUID[])
       WHERE EXISTS (
         SELECT 1
           FROM "admin"."schema_backups" b
          WHERE b."id" = r."backupId"
            AND b."isEncrypted" IS DISTINCT FROM true
       )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.cleanup_runs') IS NOT NULL THEN
          UPDATE "admin"."cleanup_runs" cr
             SET "retiredBackupId" = cr."backupId",
                 "backupId" = NULL,
                 "updatedAt" = now()
           WHERE cr."backupId" IN (
             SELECT "backupId"
               FROM "admin"."retired_schema_backups"
           );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.schema_restores') IS NOT NULL THEN
          UPDATE "admin"."schema_restores" sr
             SET "retiredBackupId" = sr."backupId",
                 "backupId" = NULL
           WHERE sr."backupId" IN (
             SELECT "backupId"
               FROM "admin"."retired_schema_backups"
           );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.cleanup_runs') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'admin.cleanup_runs'::regclass
                AND conname = 'fk_cleanup_runs_retired_backup'
           )
        THEN
          ALTER TABLE "admin"."cleanup_runs"
            ADD CONSTRAINT "fk_cleanup_runs_retired_backup"
              FOREIGN KEY ("retiredBackupId")
              REFERENCES "admin"."retired_schema_backups"("backupId")
              ON DELETE RESTRICT;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.schema_restores') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'admin.schema_restores'::regclass
                AND conname = 'fk_schema_restores_retired_backup'
           )
        THEN
          ALTER TABLE "admin"."schema_restores"
            ADD CONSTRAINT "fk_schema_restores_retired_backup"
              FOREIGN KEY ("retiredBackupId")
              REFERENCES "admin"."retired_schema_backups"("backupId")
              ON DELETE RESTRICT;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_retired_schema_backups_tenant_created"
        ON "admin"."retired_schema_backups" ("tenantId", "createdAt" DESC)
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.cleanup_runs') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS "idx_cleanup_runs_retired_backup"
            ON "admin"."cleanup_runs" ("retiredBackupId");
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.schema_restores') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS "idx_schema_restores_retired_backup"
            ON "admin"."schema_restores" ("retiredBackupId");
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DELETE FROM "admin"."schema_backups" b
      WHERE b."id" IN (
        SELECT "backupId"
          FROM "admin"."retired_schema_backups"
      )
        AND b."isEncrypted" IS DISTINCT FROM true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        RAISE EXCEPTION
          'RetirePlaintextSchemaBackups1800750000000 is forward-only; restoring plaintext backups to the active restore surface is forbidden';
      END
      $$;
    `);
  }
}
