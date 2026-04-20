import type { QueryRunner } from 'typeorm';

/**
 * Shared utilities for TypeORM migration authors (MA5).
 * ============================================================================
 *
 * Three helpers, each addressing a class of patches that has shipped to
 * main in the recent deploy history:
 *
 *   - `pinSearchPath` replaces the inline `SET search_path TO "<schema>"`
 *     boilerplate that was added to 7 migrations by commit 552f289d.
 *     Centralises the identifier validation + post-pin verification the
 *     runner uses, so every migration-author invocation is correct by
 *     construction.
 *
 *   - `dropPartialTables` replaces the inline `dropPartialHRTables` /
 *     `dropPartialSchedulingTables` helpers in CreateHRModuleSchema and
 *     CreateSchedulingTables (commits 43c6fd2c + fbee69aa). Healing
 *     partial-state skeletons left by a prior crashed migration is the
 *     runner's responsibility in the general case, but when a specific
 *     migration's CREATE TABLE IF NOT EXISTS behaviour needs a pre-check
 *     (the skeleton-exists-without-signature-column case that bit HR),
 *     this helper provides the standard "drop if empty, raise if
 *     non-empty" semantics from one place.
 *
 *   - `dropDependentPartialIndexes` replaces the SAVEPOINT-per-statement
 *     band-aid added to SyncHrEntitiesToDb1786800000000 in commit
 *     5df00179. That band-aid shifted an `ALTER COLUMN TYPE` failure
 *     from db-migrate to the boot validator (new enum never applied,
 *     SchemaDriftValidator saw drift, "Schema drift scan clean" boot
 *     signal never emitted, deploy rolled back). Root cause: partial
 *     indexes whose WHERE predicate casts a literal to the column's
 *     OLD enum type — PG re-validates the predicate during ALTER COLUMN
 *     TYPE, the new-enum = old-enum equality operator does not exist,
 *     ALTER fails. `RdbmsSchemaBuilder.log()` cannot emit a DROP INDEX
 *     because the index is a legacy artefact not declared by the entity
 *     model. This helper closes the gap deterministically: enumerate
 *     every `ALTER COLUMN TYPE` statement the migration is about to run,
 *     query pg_indexes for dependent partial indexes, DROP them
 *     explicitly, then let the ALTER proceed. After the migration the
 *     entity-declared indexes are re-created by TypeORM's own
 *     CREATE INDEX emissions. Legacy partial indexes that the entity
 *     does not declare remain dropped — which is the correct end-state
 *     under an entity-first schema contract.
 *
 * # Why not a `BaseMigration` class?
 *
 * TypeORM's `MigrationInterface` is open to extension but its shape is
 * fixed (up/down pair). A base class would have to inject `this.pinSearchPath(qr)`
 * on the author's behalf, which requires either reflection magic or
 * author-side cooperation (`await this.pinSearchPath(qr)`). The latter
 * is no better than direct function calls; the former breaks type
 * inference. Plain exported functions keep the call-site obvious:
 *
 *   export class MyMigration1234567890 implements MigrationInterface {
 *     name = 'MyMigration1234567890';
 *     async up(qr: QueryRunner): Promise<void> {
 *       await pinSearchPath(qr, 'hr');
 *       await dropPartialTables(qr, 'hr', ['my_table'], 'tenant_id');
 *       await qr.query(`CREATE TABLE IF NOT EXISTS "my_table" (...)`);
 *     }
 *   }
 *
 * # Why defensive re-pin in migrations at all, given the runners do it?
 *
 * Both the per-service `MigrationRunnerService` (in backend-common) and
 * the `aqua-db-migrate` orchestrator pin `search_path` before invoking
 * each migration's `up()`. BUT migration code also runs under:
 *   - `npm run typeorm migration:run` (developer-driven CLI)
 *   - `psql -f <migration.sql>` (hand-applied patches)
 *   - `TypeORM synchronize: true` in dev (rare, deprecated)
 *
 * The author-side `pinSearchPath` call makes the migration correct
 * under ALL invocation paths, not just the runners — and also adds a
 * `current_schema()` verification so any runner pre-pin misconfiguration
 * surfaces loudly inside the migration rather than silently running
 * against the wrong schema.
 */

/**
 * Safe SQL identifier regex — must match the regex used by both
 * migration-runner.service.ts and migration-orchestrator.ts. Kept in
 * sync by convention; if any file changes the pattern, all three must.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Pin the session-level `search_path` to the given schema (plus `public`
 * as fallback) and verify the pin took effect via `current_schema()`.
 *
 * Semantics:
 *   - Not `SET LOCAL` — the pin must survive across the BEGIN/COMMIT
 *     cycles that TypeORM's `MigrationExecutor` issues in
 *     `transaction: 'each'` mode.
 *   - Throws if the identifier is unsafe (caller passed something that
 *     isn't a SQL identifier shape).
 *   - Throws if `current_schema()` doesn't match after the pin — either
 *     the schema doesn't exist, the DB user lacks USAGE on it, or a
 *     preceding statement in the same session changed the search_path
 *     behind our back.
 *
 * Callers are encouraged to invoke this as the FIRST statement in their
 * `up()` method. The runner will have already pinned, but re-asserting
 * makes the migration correct under non-runner invocation paths too.
 */
export async function pinSearchPath(
  queryRunner: QueryRunner,
  schema: string,
): Promise<void> {
  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[pinSearchPath] Unsafe schema identifier: "${schema}". ` +
        `Must match ${SAFE_IDENT_RE.source}.`,
    );
  }

  await queryRunner.query(`SET search_path TO "${schema}", public`);

  const rows: Array<{ current_schema: string }> = await queryRunner.query(
    `SELECT current_schema()`,
  );
  const observed = rows[0]?.current_schema;
  if (observed !== schema) {
    throw new Error(
      `[pinSearchPath] search_path pin verification failed for "${schema}" — ` +
        `observed current_schema() = "${observed ?? '<null>'}". ` +
        `Ensure the schema exists and the connecting DB user has USAGE on it.`,
    );
  }
}

/**
 * Drop tables that a prior crashed run of the same migration left in a
 * partial state (skeleton present but missing the signature column).
 *
 * Rationale: when a CREATE TABLE statement commits but the migration
 * aborts before the follow-up DDL (column additions, indexes), the
 * skeleton survives — CREATE TABLE IF NOT EXISTS on retry then no-ops,
 * and subsequent statements (e.g. partial indexes referencing the
 * missing column) crash with "column does not exist". Because the
 * skeleton was never populated (the migration aborted before any
 * INSERT), dropping it is safe.
 *
 * For each table:
 *   - Table absent? skip (fresh-DB path; CREATE TABLE IF NOT EXISTS
 *     below will create it from the full declaration).
 *   - Table present + has `signatureColumn`? skip (healthy; CREATE
 *     TABLE IF NOT EXISTS will no-op, which is what we want).
 *   - Table present + missing `signatureColumn` + empty → DROP.
 *   - Table present + missing `signatureColumn` + non-empty → raise.
 *     Dropping non-empty is never correct; a human must investigate
 *     (the crash-before-INSERT invariant is broken).
 *
 * The signature column choice is migration-author's call — pick a
 * column that's defined in the CREATE TABLE and is NOT added in a
 * later migration (otherwise a legitimately-migrated old table could
 * look partial). For HR's case, `tenant_id` works because every HR
 * table carries it by design.
 *
 * @param queryRunner      Active TypeORM QueryRunner (transactional).
 * @param schema           Schema owning the tables (SAFE_IDENT_RE).
 * @param tables           Table names to check/drop (each SAFE_IDENT_RE).
 * @param signatureColumn  Column that MUST exist on a healthy table
 *                         (e.g. `'tenant_id'` for HR). Absence signals
 *                         a partial skeleton.
 */
export async function dropPartialTables(
  queryRunner: QueryRunner,
  schema: string,
  tables: readonly string[],
  signatureColumn: string,
): Promise<void> {
  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[dropPartialTables] Unsafe schema identifier: "${schema}".`,
    );
  }
  if (!SAFE_IDENT_RE.test(signatureColumn)) {
    throw new Error(
      `[dropPartialTables] Unsafe signatureColumn: "${signatureColumn}".`,
    );
  }
  for (const table of tables) {
    if (!SAFE_IDENT_RE.test(table)) {
      throw new Error(
        `[dropPartialTables] Unsafe table name in list: "${table}".`,
      );
    }
  }

  for (const table of tables) {
    // Inline identifiers are validated against SAFE_IDENT_RE above; the
    // DO block additionally wraps every dynamic reference in format('%I')
    // for defense-in-depth.
    await queryRunner.query(`
      DO $$
      DECLARE
        has_sig boolean;
        rowcount bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_tables
           WHERE schemaname = '${schema}' AND tablename = '${table}'
        ) THEN
          RETURN;
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schema}'
             AND table_name = '${table}'
             AND column_name = '${signatureColumn}'
        ) INTO has_sig;

        IF has_sig THEN
          RETURN;
        END IF;

        EXECUTE format('SELECT count(*) FROM %I.%I', '${schema}', '${table}') INTO rowcount;
        IF rowcount = 0 THEN
          EXECUTE format('DROP TABLE %I.%I CASCADE', '${schema}', '${table}');
        ELSE
          RAISE EXCEPTION
            'Partial %.% has % rows but is missing signature column % — manual intervention required',
            '${schema}', '${table}', rowcount, '${signatureColumn}';
        END IF;
      END $$;
    `);
  }
}

/**
 * `ALTER TABLE "<schema>"."<table>" ALTER COLUMN "<column>" TYPE …` target.
 *
 * Emitted by `RdbmsSchemaBuilder.log()` whenever the entity-declared column
 * type diverges from the live DB column type. For enum-to-enum changes this
 * statement hits PG's partial-index re-validation rule and fails if any
 * partial index on the table has a WHERE predicate that references the
 * column being re-typed (see `dropDependentPartialIndexes` docblock for the
 * detailed failure mode).
 */
export interface AlterColumnTypeTarget {
  schema: string;
  table: string;
  column: string;
}

/**
 * Parse `ALTER TABLE "schema"."table" ALTER COLUMN "col" TYPE …` statements
 * out of the upQueries list that `RdbmsSchemaBuilder.log()` emits.
 *
 * The regex anchors on the quoted identifier form TypeORM always uses when
 * entities declare `schema:`. Ignores any ALTER-COLUMN statement that is
 * NOT a TYPE change (SET NOT NULL, DROP DEFAULT, …) — those do not trigger
 * partial-index re-validation.
 *
 * The SQL parser is intentionally narrow: this helper does not attempt to
 * handle unquoted identifiers, cross-database dialects, or mixed-case
 * keywords beyond what TypeORM's PostgreSQL driver produces. Migrations
 * that construct DDL by hand must list their targets explicitly.
 */
export function parseAlterColumnTypeTargets(
  sqlStatements: readonly string[],
): AlterColumnTypeTarget[] {
  const pattern =
    /^ALTER\s+TABLE\s+"([^"]+)"\."([^"]+)"\s+ALTER\s+COLUMN\s+"([^"]+)"\s+(?:SET\s+DATA\s+)?TYPE\b/i;
  const seen = new Set<string>();
  const targets: AlterColumnTypeTarget[] = [];
  for (const sql of sqlStatements) {
    const trimmed = sql.trim();
    const m = pattern.exec(trimmed);
    if (!m) continue;
    const schema = m[1];
    const table = m[2];
    const column = m[3];
    if (!schema || !table || !column) continue;
    const key = `${schema}.${table}.${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ schema, table, column });
  }
  return targets;
}

/**
 * Partial index that will block an `ALTER COLUMN TYPE` if left in place.
 *
 * Returned rows always include the original `pg_get_indexdef` text so
 * operators can grep logs to understand what was dropped. The index is
 * NOT re-created by this helper — the entity-first schema contract means
 * an index the entity model does not declare SHOULD NOT exist in the DB
 * anyway. TypeORM's `RdbmsSchemaBuilder.log()` will `CREATE INDEX` any
 * index the entity declares after the ALTER succeeds.
 */
export interface BlockingPartialIndex {
  schema: string;
  table: string;
  column: string;
  indexName: string;
  indexDef: string;
}

/**
 * Enumerate every partial index on `(schema, table)` whose WHERE predicate
 * references `column`, then DROP each of them.
 *
 * # Why this is the correct architectural fix, not a patch
 *
 * PostgreSQL's `ALTER COLUMN … TYPE …` re-validates every partial index's
 * WHERE predicate against the column's NEW type. A predicate that casts a
 * literal to the column's OLD enum type — e.g.
 *   `CREATE INDEX … WHERE (status = 'active'::hr.certification_status)`
 * — cannot be re-validated when `status` becomes
 * `hr.employee_certifications_status_enum`: PG has no implicit equality
 * operator between two distinct enum types, so ALTER fails with
 *   `operator does not exist: <new_enum> = <old_enum>`.
 *
 * TypeORM's `RdbmsSchemaBuilder.log()` cannot emit a DROP INDEX for the
 * offender because the offending index was created OUTSIDE the entity
 * model (legacy artefact, hand-authored DDL, migration from an earlier
 * entity shape). `log()` only knows about entity-declared objects.
 *
 * The Tier-1 architectural fix ("make it impossible"): query pg_indexes
 * directly, drop every partial index whose predicate references the
 * column being re-typed, then let `ALTER COLUMN TYPE` run deterministically.
 * After the ALTER, any index the entity model currently declares is
 * recreated by TypeORM's own `CREATE INDEX` emissions in the same
 * migration. Legacy indexes the entity model does not declare remain
 * dropped — which is the correct end-state under an entity-first schema
 * contract (ADR-012 + SchemaDriftValidator). Operators see the dropped
 * index names in the returned list for audit.
 *
 * # Why partial indexes only, not every index on the column
 *
 * Non-partial indexes on an enum column rebuild automatically during
 * `ALTER COLUMN TYPE … USING …` because PG rewrites the tuple and
 * re-indexes. The failure mode is SPECIFIC to partial indexes whose
 * WHERE predicate contains a literal cast to the old type. Dropping
 * non-partial indexes here would be unnecessary churn and would delete
 * indexes the entity actually declares.
 *
 * # Why not pg_depend
 *
 * pg_depend surfaces every dependency, including automatically-rebuilt
 * non-partial indexes that do NOT block ALTER COLUMN TYPE. Filtering
 * pg_depend rows back down to "partial index whose predicate references
 * the column" requires re-querying pg_index / pg_get_indexdef anyway,
 * and pg_indexes already joins those for us. Using pg_indexes keeps the
 * match criterion explicit — predicate text references the column by
 * name, period.
 *
 * @returns The list of indexes that were dropped, with their original
 *          `pg_get_indexdef` text. Empty array if no blocking indexes.
 */
export async function dropDependentPartialIndexes(
  queryRunner: QueryRunner,
  targets: readonly AlterColumnTypeTarget[],
): Promise<BlockingPartialIndex[]> {
  for (const t of targets) {
    if (!SAFE_IDENT_RE.test(t.schema)) {
      throw new Error(
        `[dropDependentPartialIndexes] Unsafe schema identifier: "${t.schema}".`,
      );
    }
    if (!SAFE_IDENT_RE.test(t.table)) {
      throw new Error(
        `[dropDependentPartialIndexes] Unsafe table identifier: "${t.table}".`,
      );
    }
    if (!SAFE_IDENT_RE.test(t.column)) {
      throw new Error(
        `[dropDependentPartialIndexes] Unsafe column identifier: "${t.column}".`,
      );
    }
  }

  const dropped: BlockingPartialIndex[] = [];

  // Group targets by (schema, table) so we issue one pg_indexes lookup per table.
  const byTable = new Map<string, AlterColumnTypeTarget[]>();
  for (const t of targets) {
    const key = `${t.schema}.${t.table}`;
    const arr = byTable.get(key) ?? [];
    arr.push(t);
    byTable.set(key, arr);
  }

  for (const [, tableTargets] of byTable) {
    const first = tableTargets[0];
    if (!first) continue;
    const { schema, table } = first;

    const rows: Array<{ indexname: string; indexdef: string }> =
      await queryRunner.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2`,
        [schema, table],
      );

    for (const row of rows) {
      const wherePos = row.indexdef.search(/\bWHERE\b/i);
      if (wherePos < 0) continue; // non-partial; rebuilt automatically by ALTER
      const predicate = row.indexdef.slice(wherePos);

      for (const t of tableTargets) {
        // Column name must appear as a whole word in the predicate.
        // Escape regex metacharacters that could slip through even though
        // SAFE_IDENT_RE already rejects them — defense in depth.
        const escaped = t.column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const colRe = new RegExp(`\\b${escaped}\\b`);
        if (!colRe.test(predicate)) continue;

        await queryRunner.query(
          `DROP INDEX IF EXISTS "${schema}"."${row.indexname}"`,
        );
        dropped.push({
          schema,
          table,
          column: t.column,
          indexName: row.indexname,
          indexDef: row.indexdef,
        });
        break; // one index is blocking for at most one-column-per-target set
      }
    }
  }

  return dropped;
}
