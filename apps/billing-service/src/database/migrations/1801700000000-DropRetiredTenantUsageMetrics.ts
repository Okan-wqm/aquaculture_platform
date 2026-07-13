import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropRetiredTenantUsageMetrics — retire the dead parallel usage model
 * (A6 / DB-IDENT-MEDIUM-002, ORPHAN-MEDIUM-382).
 *
 * WHY: billing carried TWO usage-metering models. `billing.usage_aggregations`
 * + `billing.usage_hourly_data` are the live model — written by
 * UsageAggregatorService.persistDirtyData() and read by
 * MeteredBillingService.calculateBilling() and the admin usage dashboard.
 * `billing.tenant_usage_metrics` had NO writer anywhere in the codebase
 * (live droplet: 0 rows) — every read surface always saw the zero-state.
 * Its readers have been repointed to the aggregation model
 * (GetTenantBillingHandler) or deleted (admin-api readonly projection, which
 * no frontend called). Physically keeping the table would be exactly the
 * reverse-drift class the DB audit flagged for admin's legacy config trio.
 *
 * SAFETY SHAPE (archive-before-drop, idempotent — mirrors admin-api
 * 1801400000000-DropRetiredLegacyConfigStores):
 *   1. `billing.retired_usage_metrics_backup` (jsonb archive, CREATE IF NOT
 *      EXISTS, registered in MODULE_SCHEMAS['billing'].infrastructureTables)
 *      receives a full `to_jsonb(row)` copy of every source row BEFORE the
 *      drop — belt-and-braces even though the table is empty on every known
 *      environment.
 *   2. The archive step runs only when the source table still exists AND no
 *      archive rows exist yet (a partially-failed earlier run cannot
 *      double-archive on retry).
 *   3. A count assertion RAISEs (aborting the transaction) if the archive
 *      row count does not cover the source row count — the drop can never
 *      outrun the backup.
 *   4. Every step is IF-EXISTS-guarded, so the migration is correct on
 *      fresh (Baseline-built), behind, and current databases alike.
 *   5. The orphaned `tenant_usage_metrics_periodtype_enum` type is dropped
 *      only behind a pg_attribute "no dependent columns remain" gate.
 *      billing is a platform-level schema (no tenant clones reference its
 *      types), but the guarded shape is the house pattern since the harvest
 *      quality-grade outage.
 */
export class DropRetiredTenantUsageMetrics1801700000000 implements MigrationInterface {
  name = 'DropRetiredTenantUsageMetrics1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. The archive table (registered billing infrastructure) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."retired_usage_metrics_backup" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceTable" character varying(64) NOT NULL,
        "rowData" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_retired_usage_metrics_backup" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_retired_usage_metrics_backup_source"
        ON "billing"."retired_usage_metrics_backup" ("sourceTable")
    `);

    // ── 2. Archive → verify → drop ──
    await queryRunner.query(`
      DO $$
      DECLARE
        source_count bigint;
        archived_count bigint;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'billing' AND table_name = 'tenant_usage_metrics'
        ) THEN
          -- Idempotent archive: a retried run after a partial failure must not
          -- duplicate rows already copied.
          IF NOT EXISTS (
            SELECT 1 FROM "billing"."retired_usage_metrics_backup"
            WHERE "sourceTable" = 'tenant_usage_metrics'
          ) THEN
            INSERT INTO "billing"."retired_usage_metrics_backup" ("sourceTable", "rowData")
            SELECT 'tenant_usage_metrics', to_jsonb(t)
            FROM "billing"."tenant_usage_metrics" t;
          END IF;

          SELECT count(*) INTO source_count FROM "billing"."tenant_usage_metrics";
          SELECT count(*) INTO archived_count
            FROM "billing"."retired_usage_metrics_backup"
            WHERE "sourceTable" = 'tenant_usage_metrics';
          IF archived_count < source_count THEN
            RAISE EXCEPTION
              'retired_usage_metrics_backup holds % rows for tenant_usage_metrics but the source still has % — refusing to drop before the archive is complete',
              archived_count, source_count;
          END IF;

          -- DESTRUCTIVE: archived above into billing.retired_usage_metrics_backup (jsonb, count-verified); the table had no writer and 0 live rows; rollback = restore rows from the archive
          DROP TABLE IF EXISTS "billing"."tenant_usage_metrics";
        END IF;
      END $$;
    `);

    // ── 3. Orphaned enum type ──
    // SHARED-ENUM-DROP-REVIEWED: billing is a platform-level schema — tenant
    // clones never reference billing types — and the enum belonged solely to
    // tenant_usage_metrics.periodType. The pg_depend-class gate below
    // (pg_attribute join) verifies zero dependent columns remain anywhere
    // before dropping; an environment with an unexpected dependent keeps the
    // type and the run continues.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
          JOIN pg_type t ON t.oid = a.atttypid
          JOIN pg_namespace tn ON tn.oid = t.typnamespace
          WHERE tn.nspname = 'billing'
            AND t.typname = 'tenant_usage_metrics_periodtype_enum'
            AND a.attnum > 0
            AND NOT a.attisdropped
        ) THEN
          DROP TYPE IF EXISTS "billing"."tenant_usage_metrics_periodtype_enum";
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. The table never had a writer — there is no
    // application state to restore — and the full row payloads (if any
    // environment ever held rows) live in billing.retired_usage_metrics_backup
    // (jsonb). Recreating the table would resurrect the dead parallel model
    // this migration removes. Intentionally a no-op.
  }
}
