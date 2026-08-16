import type { QueryRunner } from 'typeorm';

import { executeQueryRowsNormalized } from './query-result-normalizer';

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
export async function pinSearchPath(queryRunner: QueryRunner, schema: string): Promise<void> {
  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[pinSearchPath] Unsafe schema identifier: "${schema}". ` +
        `Must match ${SAFE_IDENT_RE.source}.`,
    );
  }

  await queryRunner.query(`SET search_path TO "${schema}", public`);

  const rows = await executeQueryRowsNormalized<{ current_schema: string }>(
    queryRunner,
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
    throw new Error(`[dropPartialTables] Unsafe schema identifier: "${schema}".`);
  }
  if (!SAFE_IDENT_RE.test(signatureColumn)) {
    throw new Error(`[dropPartialTables] Unsafe signatureColumn: "${signatureColumn}".`);
  }
  for (const table of tables) {
    if (!SAFE_IDENT_RE.test(table)) {
      throw new Error(`[dropPartialTables] Unsafe table name in list: "${table}".`);
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
 * The regex matches BOTH schema-qualified `"schema"."table"` and
 * unqualified `"table"` forms. TypeORM emits unqualified table refs
 * when the migration runner has pinned search_path (the SchemaBuilder
 * trusts the session-level search_path resolution). The optional
 * `defaultSchema` parameter supplies the schema to use when the
 * statement is unqualified — without it, unqualified statements are
 * skipped (preserves the original behaviour for callers that want
 * strict-only matching).
 *
 * Ignores any ALTER-COLUMN statement that is NOT a TYPE change
 * (SET NOT NULL, DROP DEFAULT, …) — those do not trigger
 * partial-index re-validation.
 *
 * The SQL parser is intentionally narrow: this helper does not attempt
 * to handle unquoted identifiers, cross-database dialects, or
 * mixed-case keywords beyond what TypeORM's PostgreSQL driver produces.
 * Migrations that construct DDL by hand must list their targets
 * explicitly.
 */
export function parseAlterColumnTypeTargets(
  sqlStatements: readonly string[],
  defaultSchema?: string,
): AlterColumnTypeTarget[] {
  const pattern =
    /^ALTER\s+TABLE\s+(?:"([^"]+)"\.)?"([^"]+)"\s+ALTER\s+COLUMN\s+"([^"]+)"\s+(?:SET\s+DATA\s+)?TYPE\b/i;
  const seen = new Set<string>();
  const targets: AlterColumnTypeTarget[] = [];
  for (const sql of sqlStatements) {
    const trimmed = sql.trim();
    const m = pattern.exec(trimmed);
    if (!m) continue;
    const schema = m[1] ?? defaultSchema;
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
 * Kind of schema object that blocks `ALTER COLUMN TYPE` and must be
 * dropped before the ALTER proceeds. Each kind has a different DROP
 * statement, tracked separately so operators can audit what happened.
 *
 * - `partial_index` — standalone partial index (not backing any
 *   constraint). Dropped via `DROP INDEX`.
 * - `excl_or_unique_constraint` — partial EXCLUDE / UNIQUE / PRIMARY KEY
 *   constraint. PostgreSQL rejects plain `DROP INDEX` on constraint-backed
 *   indexes with `cannot drop index <name> because constraint <name> …
 *   requires it`; dropped via `ALTER TABLE … DROP CONSTRAINT`.
 * - `check_constraint` — `CHECK` constraint whose predicate casts a
 *   literal to the column's old type. PG re-validates the predicate on
 *   ALTER, same failure mode as partial-index predicates. Dropped via
 *   `ALTER TABLE … DROP CONSTRAINT`.
 */
export type BlockingDependencyKind =
  | 'partial_index'
  | 'excl_or_unique_constraint'
  | 'check_constraint';

/**
 * Schema object that will block an `ALTER COLUMN TYPE` if left in place.
 *
 * Returned rows always include the original `pg_get_indexdef` /
 * `pg_get_constraintdef` text so operators can grep logs to understand
 * what was dropped. Objects are NOT re-created by this helper — the
 * entity-first schema contract means objects the entity model does not
 * declare SHOULD NOT exist in the DB anyway. TypeORM's
 * `RdbmsSchemaBuilder.log()` will emit the recreation DDL for any object
 * the entity declares after the ALTER succeeds.
 */
export interface BlockingDependency {
  schema: string;
  table: string;
  column: string;
  kind: BlockingDependencyKind;
  /** Index name for `partial_index`; constraint name otherwise. */
  name: string;
  /** `pg_get_indexdef` for indexes; `pg_get_constraintdef` for constraints. */
  definition: string;
}

/**
 * Backwards-compatible alias. The original single-purpose helper only
 * handled partial indexes and returned a `BlockingPartialIndex` shape
 * with `indexName` + `indexDef` fields; that shape is no longer
 * sufficient now that constraint-backed indexes and CHECK constraints
 * are also handled. Prefer `BlockingDependency` in new code.
 *
 * @deprecated Use `BlockingDependency` — includes `kind` so callers can
 *             distinguish `partial_index` from `excl_or_unique_constraint`
 *             and `check_constraint`.
 */
export type BlockingPartialIndex = BlockingDependency;

/**
 * Enumerate every schema object that would block an `ALTER COLUMN TYPE`
 * on any of the given `(schema, table, column)` targets, then DROP each
 * of them in the correct way (DROP INDEX vs DROP CONSTRAINT).
 *
 * # Why this is the correct architectural fix, not a patch
 *
 * PostgreSQL re-validates three classes of dependency against the NEW
 * column type when an `ALTER COLUMN … TYPE …` runs:
 *
 *   1. **Partial-index WHERE predicates.** A predicate that casts a
 *      literal to the OLD enum type — e.g.
 *        `CREATE INDEX … WHERE (status = 'active'::hr.certification_status)`
 *      cannot be re-validated against `hr.employee_certifications_status_enum`:
 *      PG has no implicit equality operator between distinct enum types,
 *      ALTER fails with `operator does not exist: <new_enum> = <old_enum>`.
 *
 *   2. **Constraint-backed partial indexes (EXCLUDE / UNIQUE / PK).** Same
 *      predicate re-validation, but `DROP INDEX` alone is rejected by PG
 *      with `cannot drop index <name> because constraint <name> … requires
 *      it`. The correct drop is `ALTER TABLE … DROP CONSTRAINT <conname>`,
 *      which drops the constraint and its backing index atomically.
 *
 *   3. **CHECK constraints whose predicate references the column.** Same
 *      re-validation rule as partial-index predicates. Dropped via
 *      `ALTER TABLE … DROP CONSTRAINT`.
 *
 * `RdbmsSchemaBuilder.log()` does not emit the DROP DDL for any of these
 * because they are legacy artefacts outside the current entity model —
 * `log()` only knows about entity-declared objects. Left in place, the
 * ALTER fails.
 *
 * The Tier-1 architectural fix ("make it impossible"): introspect
 * pg_indexes + pg_constraint directly, drop every object whose predicate
 * (or check definition) references the column being re-typed, then let
 * `ALTER COLUMN TYPE` run deterministically. After the ALTER, any object
 * the entity model currently declares is recreated by TypeORM's own DDL
 * emissions later in the migration. Legacy objects the entity does not
 * declare remain dropped — the correct end-state under an entity-first
 * schema contract (ADR-012 + SchemaDriftValidator). Operators see the
 * dropped object names in the returned list for audit.
 *
 * # Why partial-index / partial-constraint coverage only (not every index)
 *
 * Non-partial indexes on an enum column rebuild automatically during
 * `ALTER COLUMN TYPE … USING …` because PG rewrites the tuple and
 * re-indexes. The failure surface is SPECIFIC to objects whose predicate
 * contains a literal cast to the old type. Dropping non-partial objects
 * would be unnecessary churn and would delete constraints the entity
 * model actually declares.
 *
 * # Why not pg_depend
 *
 * pg_depend surfaces every dependency, including automatically-rebuilt
 * non-partial indexes that do NOT block ALTER COLUMN TYPE. Filtering
 * pg_depend rows back down to "partial object whose predicate references
 * the column" requires re-querying pg_index + pg_constraint + definition
 * text anyway, and the direct joins used here keep the match criterion
 * explicit — predicate / check-def text references the column by name.
 *
 * @returns The list of objects that were dropped. Each entry's `kind`
 *          records how it was dropped (index vs constraint).
 */
export async function dropDependentPartialIndexes(
  queryRunner: QueryRunner,
  targets: readonly AlterColumnTypeTarget[],
): Promise<BlockingDependency[]> {
  for (const t of targets) {
    if (!SAFE_IDENT_RE.test(t.schema)) {
      throw new Error(`[dropDependentPartialIndexes] Unsafe schema identifier: "${t.schema}".`);
    }
    if (!SAFE_IDENT_RE.test(t.table)) {
      throw new Error(`[dropDependentPartialIndexes] Unsafe table identifier: "${t.table}".`);
    }
    if (!SAFE_IDENT_RE.test(t.column)) {
      throw new Error(`[dropDependentPartialIndexes] Unsafe column identifier: "${t.column}".`);
    }
  }

  const dropped: BlockingDependency[] = [];

  // Group targets by (schema, table) so we issue one lookup pair per table.
  const byTable = new Map<string, AlterColumnTypeTarget[]>();
  for (const t of targets) {
    const key = `${t.schema}.${t.table}`;
    const arr = byTable.get(key) ?? [];
    arr.push(t);
    byTable.set(key, arr);
  }

  const matchesColumn = (text: string, column: string): boolean => {
    // Column name must appear as a whole word. Escape regex metacharacters
    // that could slip through even though SAFE_IDENT_RE already rejects
    // them — defense in depth.
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const colRe = new RegExp(`\\b${escaped}\\b`);
    return colRe.test(text);
  };

  for (const [, tableTargets] of byTable) {
    const first = tableTargets[0];
    if (!first) continue;
    const { schema, table } = first;

    // ----- Pass 1: partial indexes (standalone) + partial constraint-backed indexes -----
    // LEFT JOIN pg_constraint on conindid so we know whether each index is
    // backing a constraint. When it is, DROP CONSTRAINT is the correct
    // drop path (DROP INDEX is rejected by PG).
    const indexRows = await executeQueryRowsNormalized<{
      indexname: string;
      indexdef: string;
      conname: string | null;
      contype: string | null;
    }>(
      queryRunner,
      `SELECT
         i.indexname,
         i.indexdef,
         c.conname,
         c.contype
       FROM pg_indexes i
       JOIN pg_class idx_cls ON idx_cls.relname = i.indexname
       JOIN pg_namespace idx_ns
         ON idx_ns.oid = idx_cls.relnamespace
        AND idx_ns.nspname = i.schemaname
       LEFT JOIN pg_constraint c ON c.conindid = idx_cls.oid
       WHERE i.schemaname = $1 AND i.tablename = $2`,
      [schema, table],
    );

    const droppedConstraintNames = new Set<string>();

    for (const row of indexRows) {
      const wherePos = row.indexdef.search(/\bWHERE\b/i);
      if (wherePos < 0) continue; // non-partial; PG rebuilds automatically on ALTER
      const predicate = row.indexdef.slice(wherePos);

      for (const t of tableTargets) {
        if (!matchesColumn(predicate, t.column)) continue;

        if (row.conname) {
          // Constraint-backed partial index — drop the constraint, which
          // drops its backing index atomically.
          await queryRunner.query(
            `ALTER TABLE "${schema}"."${table}" DROP CONSTRAINT "${row.conname}"`,
          );
          droppedConstraintNames.add(row.conname);
          dropped.push({
            schema,
            table,
            column: t.column,
            kind: 'excl_or_unique_constraint',
            name: row.conname,
            definition: row.indexdef,
          });
        } else {
          await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."${row.indexname}"`);
          dropped.push({
            schema,
            table,
            column: t.column,
            kind: 'partial_index',
            name: row.indexname,
            definition: row.indexdef,
          });
        }
        break; // one object is blocking for at most one column-per-target set
      }
    }

    // ----- Pass 2: CHECK constraints whose predicate references a target column -----
    // CHECK constraints are independent of indexes — they do not appear in
    // pg_indexes at all. They must be enumerated via pg_constraint and
    // dropped with ALTER TABLE … DROP CONSTRAINT.
    const checkRows = await executeQueryRowsNormalized<{
      conname: string;
      condef: string;
    }>(
      queryRunner,
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS condef
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
         WHERE ns.nspname = $1
           AND t.relname = $2
           AND c.contype = 'c'`,
      [schema, table],
    );

    for (const row of checkRows) {
      if (droppedConstraintNames.has(row.conname)) continue; // already dropped as backed index
      for (const t of tableTargets) {
        if (!matchesColumn(row.condef, t.column)) continue;

        await queryRunner.query(
          `ALTER TABLE "${schema}"."${table}" DROP CONSTRAINT "${row.conname}"`,
        );
        droppedConstraintNames.add(row.conname);
        dropped.push({
          schema,
          table,
          column: t.column,
          kind: 'check_constraint',
          name: row.conname,
          definition: row.condef,
        });
        break;
      }
    }
  }

  return dropped;
}

/**
 * Options controlling `withDdlSafety`'s behaviour. Defaults are safe for
 * the common transactional-migration path.
 */
export interface DdlSafetyOptions {
  /**
   * Target source schema — pinned via `set_config('search_path', ...)`
   * when the runner is already inside a transaction. When `false` /
   * omitted, no search_path mutation is applied (caller is responsible
   * for their own search_path via `pinSearchPath(qr, schema)` if
   * needed).
   */
  readonly schema?: string;
  /**
   * Lock-timeout applied before any DDL statement. Prevents an infinite
   * wait for ACCESS EXCLUSIVE on a hot table. Default '30s' — tuned to
   * exceed steady-state statement latency but halt clear deadlocks fast.
   */
  readonly lockTimeoutMs?: number;
  /**
   * When `true`, SKIP the transactional `SET LOCAL` path entirely —
   * for `CREATE INDEX CONCURRENTLY` and other statements that PG
   * refuses to run inside BEGIN ... COMMIT. Caller MUST invoke this
   * helper from a QueryRunner whose `isTransactionActive` is false.
   * The helper applies a session-scoped `SET lock_timeout` instead and
   * RESETs it in finally().
   */
  readonly nonTransactionalDdl?: boolean;
  /**
   * Suffix added to the advisory lock key — default is the schema.
   * Useful when two migrations legitimately target the same schema
   * simultaneously (rare; most callers leave this as-is).
   */
  readonly advisoryLockKeySuffix?: string;
}

/**
 * withDdlSafety — wrap a chunk of DDL operations in the platform's
 * cross-migration safety envelope. Replaces the ad-hoc patterns
 * scattered across 2026-04 deploy hotfixes (plan v3 R12 CRITICAL).
 *
 * Three layered guards:
 *
 *   1. search_path pin (transactional path only): parameterised
 *      `set_config('search_path', $1, true)` — no string interpolation,
 *      no injection vector. Skipped when the QueryRunner is OUTSIDE a
 *      transaction because SET LOCAL is a no-op there.
 *
 *   2. lock_timeout: bounded wait for ACCESS EXCLUSIVE. Transactional
 *      path uses `SET LOCAL lock_timeout`; non-transactional path uses
 *      session-scoped `SET lock_timeout` + RESET in finally().
 *
 *   3. Advisory lock: `pg_try_advisory_lock(hashtext('aqua-db-migrate:<key>'))`.
 *      The same key namespace the production orchestrator uses — two
 *      runners targeting the same schema serialize cleanly without
 *      deadlocking on DDL. Released in finally(), ALWAYS (prior
 *      hand-rolled attempts leaked locks on throw).
 *
 * # Non-transactional mode (nonTransactionalDdl: true)
 *
 * TypeORM's `MigrationInterface.up(qr)` typically runs inside a
 * transaction (the runner opens BEGIN before calling up()). But some
 * migrations intentionally run `CREATE INDEX CONCURRENTLY` or
 * `VACUUM FULL` which PG refuses inside BEGIN. Those migrations must:
 *
 *   class MyConcurrentIndex implements MigrationInterface {
 *     transaction = false; // TypeORM won't open a tx
 *     async up(qr: QueryRunner) {
 *       await withDdlSafety(qr, {
 *         schema: 'hr',
 *         nonTransactionalDdl: true,
 *         advisoryLockKeySuffix: 'hr',
 *       }, async () => {
 *         await qr.query('CREATE INDEX CONCURRENTLY ...');
 *       });
 *     }
 *   }
 *
 * The helper never issues BEGIN/COMMIT itself — it composes with
 * whatever transaction context the QueryRunner already carries.
 */
export async function withDdlSafety<T>(
  qr: QueryRunner,
  opts: DdlSafetyOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = buildAdvisoryLockKey(opts.advisoryLockKeySuffix ?? opts.schema ?? 'default');
  const lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
  const inTx = qr.isTransactionActive;

  // Guard: nonTransactionalDdl MUST match the runner's transaction state.
  if (opts.nonTransactionalDdl === true && inTx) {
    throw new Error(
      `[withDdlSafety] nonTransactionalDdl=true but QueryRunner is inside a transaction. ` +
        `Mark the migration class with \`transaction = false\` or wrap the DDL outside the migration runner.`,
    );
  }
  if (opts.nonTransactionalDdl !== true && !inTx) {
    // Warn — not fatal, because some orchestrators (tests) may call
    // this helper outside a tx intentionally. Non-transactional DDL
    // in a transactional-expected path surfaces a config error loudly
    // via the lock_timeout RESET logic below (session-scoped reset
    // is a no-op but does not harm correctness).
    // No-throw here; callers who want strict enforcement should pass
    // `nonTransactionalDdl: true` explicitly.
  }

  if (inTx && opts.schema) {
    // Parameterised search_path pin — no string interpolation. SAFE_IDENT_RE
    // validation lives in pinSearchPath() when the caller needs it; this
    // helper relies on the orchestrator-side validation that the schema
    // name came from a trusted source (SCHEMA_REGISTRY).
    await qr.query(`SELECT set_config('search_path', $1, true)`, [`${opts.schema},public`]);
  }

  if (inTx) {
    await qr.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
  } else {
    await qr.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  }

  // Advisory lock acquisition — pg_advisory_lock blocks until granted;
  // we use it rather than try_advisory_lock so concurrent deploys
  // serialize rather than race-fail. Lock key is a hashtext of the
  // schema, identical to the orchestrator's scheme.
  await qr.query(`SELECT pg_advisory_lock(${lockKey})`);

  try {
    return await fn();
  } finally {
    // ALWAYS release the advisory lock, even on exception. A leaked
    // lock blocks every subsequent deploy for this schema until the
    // connection is killed manually.
    try {
      await qr.query(`SELECT pg_advisory_unlock(${lockKey})`);
    } catch {
      // Swallow — unlock-on-already-released is harmless; we'd rather
      // surface the original error than mask it with a second throw.
    }
    if (!inTx) {
      // Reset the session-scoped lock_timeout so downstream statements
      // on the same connection aren't stuck with our guard value.
      try {
        await qr.query(`RESET lock_timeout`);
      } catch {
        // Connection may have been closed already by the caller; ignore.
      }
    }
  }
}

/**
 * Deterministic advisory-lock key derived from the schema (or any
 * caller-supplied suffix). Identical scheme to the aqua-db-migrate
 * orchestrator's `advisoryLockKey()` so two runners serialize cleanly.
 *
 * Escapes single quotes in the schema name to prevent SQL injection
 * through the inlined literal (the key is NOT parameterised because
 * pg_advisory_lock takes a bigint, not a text arg).
 */
function buildAdvisoryLockKey(suffix: string): string {
  const safe = suffix.replace(/'/g, "''");
  return `hashtext('aqua-db-migrate:${safe}')`;
}
