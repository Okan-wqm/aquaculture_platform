/**
 * Shared TypeORM migration helpers for column/table existence guards.
 *
 * # Why these exist
 *
 * Migrations written before a baseline-restore (Wave 4-A.2) often
 * assumed a column or table existed because an earlier migration —
 * since squashed out of source — created it. On a fresh-volume bootstrap
 * the assumption fails (`relation/column "x" does not exist`).
 *
 * The architectural fix is to guard the dependent SQL with an existence
 * check that consults `information_schema`. When the column/table is
 * present (legacy DBs that ran the now-deleted migration), the migration
 * behaves identically. When absent (fresh DBs whose baseline already
 * created the canonical shape), the migration logs a skip-with-reason
 * and proceeds.
 *
 * Both helpers honor the per-migration session `search_path` set by
 * `MigrationRunnerService.pinSearchPath`. Callers do NOT need to pass a
 * schema name — `current_schema()` resolves to the schema the migration
 * is currently running against (source schema for source-only DDL,
 * `tenant_<uuid>` schema for tenant-aware fan-out).
 *
 * # Usage
 *
 *   import { columnExists, tableExists } from '@aquaculture/backend-common/database';
 *
 *   if (await tableExists(queryRunner, 'feeds')) {
 *     await queryRunner.query(`ALTER TABLE "feeds" ADD COLUMN ...`);
 *   } else {
 *     this.logger.log('Skipping feeds ALTER — table not present on this DB');
 *   }
 *
 *   if (await columnExists(queryRunner, 'species', 'isCleanerFish')) {
 *     await queryRunner.query(`UPDATE "species" SET tags = ... WHERE "isCleanerFish" = true`);
 *   } else {
 *     this.logger.log('Skipping isCleanerFish backfill — column never created on this DB');
 *   }
 *
 * # Why current_schema(), not a schema parameter
 *
 * Migrations may run repeatedly with different `search_path` values when
 * the schema is tenant-aware (per-tenant fan-out at db-migrate time).
 * Hard-coding a schema name into the lookup would defeat the routing.
 * `current_schema()` always reflects the leftmost search_path entry —
 * exactly the one the surrounding DDL resolves against.
 */

import type { QueryRunner } from 'typeorm';

import { executeQueryRowsNormalized } from './query-result-normalizer';

/**
 * Returns true when the given column exists on the given table in the
 * current schema (per `current_schema()`). Use to guard ALTER COLUMN /
 * UPDATE / SELECT statements that reference columns added by a now-
 * squashed earlier migration.
 *
 * @param queryRunner active migration QueryRunner
 * @param table       unqualified table name
 * @param column      unqualified column name (case-sensitive)
 */
export async function columnExists(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await executeQueryRowsNormalized<{ exists: boolean }>(
    queryRunner,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return rows[0]?.exists === true;
}

/**
 * Returns true when the given table exists in the current schema.
 * Use to guard ALTER TABLE / CREATE INDEX / CREATE MATERIALIZED VIEW
 * / FK ADD CONSTRAINT statements that reference a table created by a
 * now-squashed earlier migration.
 *
 * @param queryRunner active migration QueryRunner
 * @param table       unqualified table name
 */
export async function tableExists(queryRunner: QueryRunner, table: string): Promise<boolean> {
  const rows = await executeQueryRowsNormalized<{ exists: boolean }>(
    queryRunner,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = $1
     ) AS exists`,
    [table],
  );
  return rows[0]?.exists === true;
}
