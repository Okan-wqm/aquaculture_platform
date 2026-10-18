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

import { migrationRunnerSchemas } from '@platform/service-catalog';
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
 *
 * ARIA-LOW-405: the vocabulary is a TYPE, so a migration that writes
 * `columnType: 'uuid NOT NULL'` does not compile. The plain names below are
 * the one list both the type and the runtime check read. The parameterised
 * forms are spelled twice (template literal here, pattern in COLUMN_TYPE_RE)
 * because a `${number}` placeholder also admits `1.5` or `-1`: the type
 * catches a wrong word at compile time, the pattern a wrong number at run
 * time.
 */
const PLAIN_COLUMN_TYPES = [
  'uuid',
  'text',
  'boolean',
  'smallint',
  'integer',
  'bigint',
  'date',
  'timestamptz',
  'jsonb',
] as const;

type PlainColumnType = (typeof PLAIN_COLUMN_TYPES)[number];

type ParameterisedColumnType =
  | `numeric(${number},${number})`
  | `numeric(${number}, ${number})`
  | `character varying(${number})`
  | `char(${number})`;

type ScalarColumnType = PlainColumnType | ParameterisedColumnType;

/** A column type from the vocabulary, optionally an array of it. */
export type MigrationColumnTypeName = ScalarColumnType | `${ScalarColumnType}[]`;

/** A column type from the vocabulary, or an enum type by validated name. */
export type MigrationColumnType = MigrationColumnTypeName | { readonly enumType: string };

const COLUMN_TYPE_RE = new RegExp(
  `^(?:${PLAIN_COLUMN_TYPES.join('|')}|numeric\\(\\d{1,3}, ?\\d{1,3}\\)|character varying\\(\\d{1,5}\\)|char\\(\\d{1,5}\\))(?:\\[\\])?$`,
);

/**
 * The runtime half of the vocabulary: true when `value` is a type name the
 * helper adds, with digit parameters in range. A value that reached the helper
 * past the type (a cast, a JavaScript caller) is refused by this check.
 */
export function isMigrationColumnTypeName(value: string): value is MigrationColumnTypeName {
  return COLUMN_TYPE_RE.test(value);
}

/**
 * The SQL for the column type. An enum type lives with its table: for an
 * unqualified table it is unqualified too, so both resolve on the migration's
 * search_path (the source schema, or the tenant schema when tenant
 * provisioning replays the migrations with search_path pinned to it); for a
 * schema-qualified table it carries the same schema, so the two can never
 * resolve to different schemas. The precondition is that the enum already
 * exists there, created by an earlier migration with the same qualification
 * (unqualified, so a tenant replay creates it in the tenant schema too); this
 * helper never creates one.
 */
function columnTypeSql(type: MigrationColumnType, schema: string | undefined): string {
  if (typeof type === 'object') {
    const enumType = `"${validateSqlIdentifier(type.enumType, 'type')}"`;
    return schema === undefined ? enumType : `"${schema}".${enumType}`;
  }
  if (!isMigrationColumnTypeName(type)) {
    throw new Error(
      `addColumnWithIndex: column type ${JSON.stringify(type)} is not in the helper's vocabulary ` +
        '(a nullable column of a known type only; NOT NULL / DEFAULT / REFERENCES belong to a later step)',
    );
  }
  return type;
}

/**
 * The schemas a migration may name: those owning a migration lane in the
 * platform schema topology (@platform/service-catalog). `public` (never a
 * table home, CLAUDE.md), a `tenant_<uuid>` clone (provisioning routes those
 * through search_path; a migration never names one) and any name the topology
 * does not list are outside it.
 */
const MIGRATION_SCHEMAS: ReadonlySet<string> = new Set(migrationRunnerSchemas());

/**
 * The qualified target, refused when `schema` is not a migration-lane schema
 * (MIGRATION_SCHEMAS) or would pin a PER-TENANT table to its source schema.
 * Tenant provisioning replays migrations with search_path pinned to the tenant; only unqualified DDL follows it, and
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
  if (!MIGRATION_SCHEMAS.has(safeSchema)) {
    throw new Error(
      `addColumnWithIndex: schema "${safeSchema}" owns no migration lane in the platform schema topology ` +
        `(${[...MIGRATION_SCHEMAS].join(', ')}); public, tenant clones and unlisted schemas are refused — ` +
        'leave a per-tenant table unqualified so search_path routes it',
    );
  }
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

/**
 * True when a single-row SELECT returned exactly one row whose `column` is the
 * boolean true. The driver types rows as `any`; this is the one place they are
 * narrowed.
 */
function singleRowIsTrue(rows: unknown, column: string): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row: unknown = rows[0];
  return typeof row === 'object' && row !== null && Reflect.get(row, column) === true;
}

/** An index name qualified exactly as its table (an index lives in its table's schema). */
function qualifiedIndex(indexName: string, schema: string | undefined): string {
  return schema === undefined ? `"${indexName}"` : `"${schema}"."${indexName}"`;
}

/**
 * `CREATE INDEX ... IF NOT EXISTS` is satisfied by ANY relation of that name,
 * including an INVALID index: a failed or cancelled `CREATE INDEX
 * CONCURRENTLY` leaves its index behind with `pg_index.indisvalid = false`,
 * and it serves no query. The guarded build would then skip it in silence, on
 * every later run. So the helper reads the index back (resolved through
 * to_regclass exactly as the DDL named it) and refuses to finish unless it is
 * a valid index.
 */
async function assertValidIndex(queryRunner: SqlStatementRunner, index: string): Promise<void> {
  const rows = await queryRunner.query(
    'SELECT "indisvalid" AS "valid" FROM pg_index WHERE "indexrelid" = to_regclass($1)',
    [index],
  );
  if (singleRowIsTrue(rows, 'valid')) return;
  throw new Error(
    `addColumnWithIndex: ${index} is not a valid index after CREATE INDEX IF NOT EXISTS ` +
      '(an INVALID index left by a failed CONCURRENTLY build, or another relation of that name); ' +
      `drop it (DROP INDEX CONCURRENTLY IF EXISTS ${index}) and run the migration again`,
  );
}

export interface AddColumnWithIndexOptions {
  /** Unqualified table name (search_path routes it) unless `schema` is set. */
  table: string;
  /** The column being added — always NULLABLE. */
  column: string;
  /** A type from the helper's vocabulary, or `{ enumType }` (see columnTypeSql). */
  columnType: MigrationColumnType;
  /** Convention: IDX_<table>_<cols>. */
  indexName: string;
  /** Index columns; defaults to the added column. Order is preserved. */
  indexColumns?: string[];
  /**
   * Explicit schema — only for cross-tenant infrastructure tables
   * (MODULE_SCHEMAS `infrastructureTables`) or a platform service's own
   * schema, and only a schema with a migration lane (MIGRATION_SCHEMAS). A
   * per-tenant table in a tenant-aware schema is refused.
   */
  schema?: string;
  /**
   * `CREATE INDEX CONCURRENTLY`, for a table large enough that the
   * write lock matters. Requires a runner with no open transaction (set
   * `transaction = false` on the migration); refused otherwise. Without it
   * the index build locks writes, which is meant for small tables only.
   *
   * A CONCURRENTLY build that fails leaves an INVALID index of that name;
   * the helper reads the index back after every build and fails the
   * migration on one (assertValidIndex), naming the DROP that clears it.
   * TimescaleDB does not support CONCURRENTLY on a hypertable and fails the
   * statement, so a hypertable's index is built without this option.
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
  const { target, schema } = qualifiedTarget(table, options.schema);
  const type = columnTypeSql(options.columnType, schema);
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
  await assertValidIndex(queryRunner, qualifiedIndex(indexName, schema));
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
  await queryRunner.query(`DROP INDEX IF EXISTS ${qualifiedIndex(indexName, schema)}`);
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
  const rows: unknown = await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return singleRowIsTrue(rows, 'exists');
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
  const rows: unknown = await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = $1
     ) AS exists`,
    [table],
  );
  return singleRowIsTrue(rows, 'exists');
}
