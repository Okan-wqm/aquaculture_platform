import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminBackupSubsystem — WAL-G is the sole PostgreSQL backup and restore
 * authority (ADR-0009); the admin-api in-process pg_dump ledger is retired.
 *
 * WHY: `admin.schema_backups`, `admin.schema_restores` and
 * `admin.retired_schema_backups` recorded backups produced by an in-process
 * `pg_dump` that required an encryption key production never set, wrote to a
 * volume nothing mounted, ran on every replica, and whose restore executor
 * rejected unconditionally. Every production row is a failed attempt; the
 * tables asserted a recovery capability the platform did not have. The
 * hash-pinned WAL-G control plane (`tools/scripts/database/*`, the DR
 * workflows) is the one that restores.
 *
 * A tenant schema drop still carries evidence, but of the artifact that
 * exists: the WAL-G archive epoch and the WAL position captured before the
 * drop (`recoveryPoint*` columns on `admin.cleanup_runs`). The historical
 * `backup*` columns stay — they are the record of what past runs claimed —
 * but nothing references the dropped tables any more.
 *
 * SAFETY SHAPE (archive-before-drop, per-table, idempotent — same shape as
 * 1801400000000-DropRetiredLegacyConfigStores):
 *   1. `admin.retired_backup_ledger` (jsonb archive, registered in
 *      MODULE_SCHEMAS['admin'].infrastructureTables) receives a full
 *      `to_jsonb(row)` copy of every source row BEFORE its table drops.
 *   2. The archive step is guarded per source table and cannot double-archive.
 *   3. A count assertion RAISEs (aborting the transaction) if the archive is
 *      short of the source — the drop can never outrun the archive.
 *   4. Foreign keys from `cleanup_runs` to the dropped tables go first; the
 *      referencing columns stay nullable and keep their historical values.
 *   5. Every step is IF-EXISTS-guarded so the migration is correct on fresh,
 *      behind, and current databases alike.
 */
export class RetireAdminBackupSubsystem1808300000000 implements MigrationInterface {
  name = 'RetireAdminBackupSubsystem1808300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // ── 1. Recovery-point columns on the cleanup ledger ──
    await queryRunner.query(`
      ALTER TABLE "admin"."cleanup_runs"
        ADD COLUMN IF NOT EXISTS "recoveryPointEpoch" VARCHAR(120) NULL,
        ADD COLUMN IF NOT EXISTS "recoveryPointLsn" VARCHAR(32) NULL,
        ADD COLUMN IF NOT EXISTS "recoveryPointCapturedAt" TIMESTAMPTZ NULL
    `);

    // ── 2. Foreign keys into the retired tables ──
    await queryRunner.query(`
      ALTER TABLE "admin"."cleanup_runs"
        DROP CONSTRAINT IF EXISTS "fk_cleanup_runs_backup",
        DROP CONSTRAINT IF EXISTS "fk_cleanup_runs_retired_backup"
    `);

    // ── 3. The archive table (registered admin infrastructure) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."retired_backup_ledger" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceTable" character varying(64) NOT NULL,
        "rowData" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_retired_backup_ledger" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_retired_backup_ledger_source"
        ON "admin"."retired_backup_ledger" ("sourceTable")
    `);

    // ── 4. Archive → verify → drop, per retired table (restores first: it
    //      references backups; the retired ledger references nothing) ──
    for (const table of ['schema_restores', 'retired_schema_backups', 'schema_backups']) {
      await queryRunner.query(`
        DO $$
        DECLARE
          source_count bigint;
          archived_count bigint;
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'admin' AND table_name = '${table}'
          ) THEN
            IF NOT EXISTS (
              SELECT 1 FROM "admin"."retired_backup_ledger"
              WHERE "sourceTable" = '${table}'
            ) THEN
              EXECUTE format(
                'INSERT INTO "admin"."retired_backup_ledger" ("sourceTable", "rowData")
                 SELECT %L, to_jsonb(t) FROM "admin".%I t',
                '${table}', '${table}'
              );
            END IF;

            EXECUTE format('SELECT count(*) FROM "admin".%I', '${table}') INTO source_count;
            SELECT count(*) INTO archived_count
              FROM "admin"."retired_backup_ledger" WHERE "sourceTable" = '${table}';
            IF archived_count < source_count THEN
              RAISE EXCEPTION
                'retired_backup_ledger holds % rows for % but the source still has % — refusing to drop before the archive is complete',
                archived_count, '${table}', source_count;
            END IF;

            EXECUTE format(
              -- DESTRUCTIVE: archived above into admin.retired_backup_ledger (jsonb, count-verified); WAL-G is the backup authority (ADR-0009); rollback = restore rows from the archive
              'DROP TABLE IF EXISTS "admin".%I CASCADE',
              '${table}'
            );
          END IF;
        END $$;
      `);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. The backup executor these tables recorded is
    // deleted from admin-api (ADR-0009); recreating the ledger would resurrect
    // a claim of recoverability the platform does not honour. Row payloads live
    // in admin.retired_backup_ledger (jsonb) should anything need inspecting.
  }
}
