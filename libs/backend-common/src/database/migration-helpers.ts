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

import { validateSqlIdentifier } from './sql-identifier.util';

/**
 * The narrow runner surface the DDL pair helpers need: one statement
 * at a time. A real TypeORM QueryRunner satisfies this structurally,
 * and tests record statements without any cast (the `as unknown as`
 * pattern is banned). Declaring our own interface instead of
 * Pick<QueryRunner, 'query'> keeps the overload-heavy typeorm
 * signature out of the contract.
 */
export interface SqlStatementRunner {
  query(statement: string, parameters?: unknown[]): Promise<unknown>;
}

export interface AddColumnWithIndexOptions {
  /** Unqualified table name (search_path routes it) unless `schema` is set. */
  table: string;
  /** The column being added. */
  column: string;
  /** Raw SQL type fragment, e.g. 'uuid', 'timestamptz', 'text'. */
  columnType: string;
  /** Convention: IDX_<table>_<cols>. */
  indexName: string;
  /** Index columns; defaults to the added column. Order is preserved. */
  indexColumns?: string[];
  /**
   * Explicit schema for cross-tenant infrastructure tables living in a
   * service schema (MODULE_SCHEMAS). Omitted by default so per-tenant
   * search_path routing keeps working — the same doctrine as the
   * current_schema() lookups above.
   */
  schema?: string;
}

/**
 * DEBT-2026-05-07-001 — the shared add-column-then-index pair.
 *
 * The TypeORM generator copies the idempotent `ADD COLUMN IF NOT
 * EXISTS` + `CREATE INDEX IF NOT EXISTS` boilerplate verbatim into
 * every service migration; the pairs drifted and the maintenance cost
 * multiplied. One helper enforces the contract: both halves guarded,
 * identifiers validated and quoted, unqualified DDL by default (tenant
 * search_path routing) with an explicit schema for infrastructure
 * tables.
 */
export async function addColumnWithIndex(
  queryRunner: SqlStatementRunner,
  options: AddColumnWithIndexOptions,
): Promise<void> {
  const table = validateSqlIdentifier(options.table, 'table');
  const column = validateSqlIdentifier(options.column, 'column');
  const indexName = validateSqlIdentifier(options.indexName, 'index');
  const indexColumns = (options.indexColumns ?? [options.column]).map((c) =>
    validateSqlIdentifier(c, 'column'),
  );
  const target = options.schema
    ? `"${validateSqlIdentifier(options.schema, 'schema')}"."${table}"`
    : `"${table}"`;
  await queryRunner.query(
    `ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS "${column}" ${options.columnType}`,
  );
  await queryRunner.query(
    `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${target} (${indexColumns
      .map((c) => `"${c}"`)
      .join(', ')})`,
  );
}

export interface DropColumnWithIndexOptions {
  table: string;
  column: string;
  indexName: string;
  schema?: string;
}

/**
 * The down() counterpart of addColumnWithIndex — the guarded drop pair
 * in reverse order (index first, then the column it reads).
 */
export async function dropColumnWithIndex(
  queryRunner: SqlStatementRunner,
  options: DropColumnWithIndexOptions,
): Promise<void> {
  const table = validateSqlIdentifier(options.table, 'table');
  const column = validateSqlIdentifier(options.column, 'column');
  const indexName = validateSqlIdentifier(options.indexName, 'index');
  if (options.schema) {
    const schema = validateSqlIdentifier(options.schema, 'schema');
    await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."${indexName}"`);
    await queryRunner.query(`ALTER TABLE "${schema}"."${table}" DROP COLUMN IF EXISTS "${column}"`);
    return;
  }
  await queryRunner.query(`DROP INDEX IF EXISTS "${indexName}"`);
  await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
}

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
  const rows: Array<{ exists: boolean }> = await queryRunner.query(
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
  const rows: Array<{ exists: boolean }> = await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = $1
     ) AS exists`,
    [table],
  );
  return rows[0]?.exists === true;
}
