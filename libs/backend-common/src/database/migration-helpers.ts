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

import { MODULE_SCHEMAS } from './schema-manager.service';
import { validateSqlIdentifier } from './sql-identifier.util';
import { TENANT_AWARE_SCHEMAS } from './tenant-aware-schemas';

/**
 * The narrow runner surface the DDL pair helpers need: one statement at a
 * time, and whether a transaction is open (``CREATE INDEX CONCURRENTLY``
 * cannot run inside one). A real TypeORM QueryRunner satisfies this
 * structurally, and tests record statements without any cast (the
 * `as unknown as` pattern is banned).
 */
export interface SqlStatementRunner {
  readonly isTransactionActive: boolean;
  query(statement: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * The column types the helper adds: a fixed vocabulary, optionally an array.
 * There is no free-text SQL here — no NOT NULL, DEFAULT, REFERENCES or `;` can
 * ride in a type — so the helper only ever adds a NULLABLE column: step 1 of
 * the blue-green sequence (nullable column → backfill → NOT NULL) by
 * construction, which migration-sql-lint's single-step NOT NULL rule (R2)
 * therefore never has to see through.
 */
const COLUMN_TYPE_RE =
  /^(?:uuid|text|boolean|smallint|integer|bigint|date|timestamptz|jsonb|numeric\(\d{1,3},\s?\d{1,3}\)|character varying\(\d{1,5}\)|char\(\d{1,5}\))(?:\[\])?$/;

/** A column type from the allowlist, or an enum type by validated name. */
export type MigrationColumnType = string | { readonly enumType: string };

function columnTypeSql(type: MigrationColumnType): string {
  if (typeof type === 'object') {
    // Unqualified, like the table: search_path routes it per tenant.
    return `"${validateSqlIdentifier(type.enumType, 'type')}"`;
  }
  if (!COLUMN_TYPE_RE.test(type)) {
    throw new Error(
      `addColumnWithIndex: column type ${JSON.stringify(type)} is not in the helper's vocabulary ` +
        '(a nullable column of a known type only; NOT NULL / DEFAULT / REFERENCES belong to a later step)',
    );
  }
  return type;
}

/**
 * The qualified target, refused when `schema` would pin a PER-TENANT table to
 * its source schema. Tenant provisioning replays migrations with search_path
 * pinned to the tenant; only unqualified DDL follows it, and
 * tenant-aware-migration-ddl-guard can only see a literal `"schema"."table"`
 * in migration text — not one the helper builds. So the helper refuses it: in
 * a tenant-aware source schema, only the module's `infrastructureTables`
 * (cross-tenant by declaration) may be named with their schema.
 */
function qualifiedTarget(
  table: string,
  schema: string | undefined,
): { target: string; schema?: string } {
  if (schema === undefined) {
    return { target: `"${table}"` };
  }
  const safeSchema = validateSqlIdentifier(schema, 'schema');
  if (TENANT_AWARE_SCHEMAS.has(safeSchema)) {
    const infrastructure = MODULE_SCHEMAS.filter(
      (module) => module.sourceSchema === safeSchema,
    ).flatMap((module) => module.infrastructureTables ?? []);
    if (!infrastructure.includes(table)) {
      throw new Error(
        `addColumnWithIndex: "${safeSchema}"."${table}" is a per-tenant table in a tenant-aware schema; ` +
          'leave it unqualified so tenant provisioning routes it (only MODULE_SCHEMAS infrastructureTables take a schema)',
      );
    }
  }
  return { target: `"${safeSchema}"."${table}"`, schema: safeSchema };
}

export interface AddColumnWithIndexOptions {
  /** Unqualified table name (search_path routes it) unless `schema` is set. */
  table: string;
  /** The column being added — always NULLABLE. */
  column: string;
  /** A type from the helper's vocabulary, or `{ enumType }`. */
  columnType: MigrationColumnType;
  /** Convention: IDX_<table>_<cols>. */
  indexName: string;
  /** Index columns; defaults to the added column. Order is preserved. */
  indexColumns?: string[];
  /**
   * Explicit schema — only for cross-tenant infrastructure tables
   * (MODULE_SCHEMAS `infrastructureTables`) or a platform service's own
   * schema. A per-tenant table in a tenant-aware schema is refused.
   */
  schema?: string;
  /**
   * `CREATE INDEX CONCURRENTLY`, for a table large enough that the
   * write lock matters. Requires a runner with no open transaction (set
   * `transaction = false` on the migration); refused otherwise. Without it
   * the index build locks writes, which is meant for small tables only.
   */
  concurrently?: boolean;
}

/**
 * DEBT-2026-05-07-001 — the shared add-column-then-index pair.
 *
 * The TypeORM generator copies the idempotent `ADD COLUMN IF NOT
 * EXISTS` + `CREATE INDEX IF NOT EXISTS` boilerplate verbatim into
 * every service migration; the pairs drifted and the maintenance cost
 * multiplied. One helper enforces the contract: both halves guarded,
 * identifiers validated and quoted, a NULLABLE column of an allowlisted
 * type, unqualified DDL by default (tenant search_path routing), and a
 * schema only where the table is cross-tenant by declaration.
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
  const type = columnTypeSql(options.columnType);
  const { target } = qualifiedTarget(table, options.schema);
  if (options.concurrently === true && queryRunner.isTransactionActive) {
    throw new Error(
      'addColumnWithIndex: CREATE INDEX CONCURRENTLY cannot run inside a transaction ' +
        '(declare `transaction = false` on the migration)',
    );
  }
  await queryRunner.query(`ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS "${column}" ${type}`);
  await queryRunner.query(
    `CREATE INDEX ${options.concurrently === true ? 'CONCURRENTLY ' : ''}IF NOT EXISTS "${indexName}" ON ${target} (${indexColumns
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
 * The down() counterpart of addColumnWithIndex — the guarded drop pair in
 * reverse order (index first, then the column it reads), qualified exactly as
 * the create was (an index lives in its table's schema).
 *
 * Use it only in the down() of a migration whose up() ADDED this column with
 * addColumnWithIndex: `ADD COLUMN IF NOT EXISTS` is a no-op for a column that
 * already existed, but this drop is not — it would remove a column the
 * migration never created.
 */
export async function dropColumnWithIndex(
  queryRunner: SqlStatementRunner,
  options: DropColumnWithIndexOptions,
): Promise<void> {
  const table = validateSqlIdentifier(options.table, 'table');
  const column = validateSqlIdentifier(options.column, 'column');
  const indexName = validateSqlIdentifier(options.indexName, 'index');
  const { target, schema } = qualifiedTarget(table, options.schema);
  const index = schema === undefined ? `"${indexName}"` : `"${schema}"."${indexName}"`;
  await queryRunner.query(`DROP INDEX IF EXISTS ${index}`);
  await queryRunner.query(`ALTER TABLE ${target} DROP COLUMN IF EXISTS "${column}"`);
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
