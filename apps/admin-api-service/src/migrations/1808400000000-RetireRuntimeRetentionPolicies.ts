import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireRuntimeRetentionPolicies — retention windows are build-time
 * commitments enforced by one registry-driven service (ADR-0012); the
 * operator-editable `admin.retention_policies` store is retired.
 *
 * WHY: the table fed a second retention engine (`applyRetentionPolicies`)
 * that ran at the same 03:00 as the canonical one, deleted `activity_logs`
 * with no legal-hold predicate, and accepted any integer an operator typed —
 * a screen that let an operator enter `-1` into the field that deletes the
 * security ledger. Its `retentionDays` and `complianceFrameworks` columns
 * were write-only decoration the engine never read. Retention is now
 * declared once in code (AdminApiRetentionBootstrapModule), bound to entity
 * metadata, and reviewed like code.
 *
 * SAFETY SHAPE: archive-before-drop into `admin.retired_config_backups` — the
 * existing jsonb archive for retired configuration stores (1801400000000) —
 * with the same count assertion and idempotency guard.
 */
export class RetireRuntimeRetentionPolicies1808400000000 implements MigrationInterface {
  name = 'RetireRuntimeRetentionPolicies1808400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."retired_config_backups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceTable" character varying(64) NOT NULL,
        "rowData" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_retired_config_backups" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        source_count bigint;
        archived_count bigint;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'retention_policies'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM "admin"."retired_config_backups"
            WHERE "sourceTable" = 'retention_policies'
          ) THEN
            INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
            SELECT 'retention_policies', to_jsonb(t) FROM "admin"."retention_policies" t;
          END IF;

          SELECT count(*) INTO source_count FROM "admin"."retention_policies";
          SELECT count(*) INTO archived_count
            FROM "admin"."retired_config_backups" WHERE "sourceTable" = 'retention_policies';
          IF archived_count < source_count THEN
            RAISE EXCEPTION
              'retired_config_backups holds % rows for retention_policies but the source still has % — refusing to drop before the archive is complete',
              archived_count, source_count;
          END IF;

          -- DESTRUCTIVE: archived above into admin.retired_config_backups (jsonb, count-verified); retention is declared in code (ADR-0012); rollback = restore rows from the archive
          DROP TABLE IF EXISTS "admin"."retention_policies";
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. Recreating an operator-editable retention
    // store would reinstate a second retention authority (ADR-0012). The row
    // payloads live in admin.retired_config_backups should anything need
    // inspecting.
  }
}
