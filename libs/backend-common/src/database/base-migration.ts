import type { QueryRunner } from 'typeorm';

/**
 * Shared utilities for TypeORM migration authors (MA5).
 * ============================================================================
 *
 * Two helpers, both addressing classes of patches that have shipped to
 * main in the last 48 hours:
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
