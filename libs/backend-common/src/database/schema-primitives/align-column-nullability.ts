/**
 * alignColumnNullability — Class C primitive (entity NOT NULL, DB nullable).
 * ============================================================================
 *
 * Heals the class that caused the HR deploy-loop on 2026-04-21 (see
 * docs/reviews/orphan-findings.md DEPLOY-CRITICAL-004). Entity declares
 * `nullable: false`; DB column was provisioned nullable. SchemaDriftValidator
 * blocks the boot signal, deploy asserter times out, rollback.
 *
 * # Safety contract (in order)
 *
 *   1. sql.ident validation of every identifier at the call site.
 *   2. @EncryptedAtRest refusal — if the caller supplies an entity class
 *      and any target column matches a decorated property, the primitive
 *      throws. Encrypted columns migrate via the key-rotation runbook.
 *   3. withDdlSafety envelope — search_path pin, lock_timeout, advisory
 *      lock in try/finally.
 *   4. Precondition check — for each column, the primitive:
 *      a. Confirms the column currently EXISTS and IS_NULLABLE='YES'
 *         (no-op otherwise; idempotent)
 *      b. Counts rows where the column IS NULL. If > 0, the primitive
 *         rejects UNLESS `opts.backfillExpr` was supplied; in that case
 *         it runs UPDATE ... SET col = backfillExpr WHERE col IS NULL,
 *         then re-counts to ensure no residual NULLs, then ALTERs.
 *      c. Runs `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`.
 *
 * # Why two-step (UPDATE, then ALTER)?
 *
 * PG's `SET NOT NULL` is rejected if any row holds NULL in the column.
 * The two-step pattern avoids the ambiguity of `ALTER COLUMN ... SET
 * NOT NULL DEFAULT expr` (which does NOT backfill existing rows — only
 * inserts going forward). An explicit UPDATE is the only reliable
 * backfill path.
 *
 * # Non-blocking under concurrent writes?
 *
 * `SET NOT NULL` requires ACCESS EXCLUSIVE lock on the table. Under
 * withDdlSafety, lock_timeout caps that wait at 30s. If the table is
 * hot and the timeout trips, the migration fails safely; the caller
 * retries during a maintenance window.
 */
import type { QueryRunner } from 'typeorm';

import type { ClassConstructor } from '../../types/class-constructor';
import { withDdlSafety } from '../base-migration';
import { getEncryptedAtRestMetadata } from '../encrypted-at-rest.decorator';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql, type SqlFragment } from '../sql-fragments';

export interface AlignColumnNullabilitySpec {
  /** DB column name — SAFE_IDENT_RE validated. */
  readonly name: string;
  /**
   * Optional backfill expression, evaluated for every row where
   * `column IS NULL` BEFORE `SET NOT NULL` runs. MUST be a SqlFragment
   * — raw-string defaults are a compile error.
   *
   * Fragment may contain bound parameters — unlike addMissingColumns's
   * DEFAULT (which is DDL-time), this is UPDATE (DML-time) where PG
   * DOES bind parameters.
   */
  readonly backfillExpr?: SqlFragment;
}

export interface AlignColumnNullabilityOptions {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly AlignColumnNullabilitySpec[];
  /** Optional entity class for @EncryptedAtRest cross-check. */
  readonly entity?: ClassConstructor;
  readonly lockTimeoutMs?: number;
}

export interface AlignColumnNullabilityResult {
  /** Column names that were flipped from NULL → NOT NULL this call. */
  readonly aligned: readonly string[];
  /** Column names already NOT NULL — no-op. */
  readonly skipped: readonly string[];
  /** Column names where backfill was applied before the ALTER. */
  readonly backfilled: readonly string[];
}

/**
 * Align DB column nullability to the entity's NOT NULL declaration.
 * Idempotent — columns already NOT NULL are no-ops. Rejects when the
 * column holds NULL values and no backfill was supplied.
 */
export async function alignColumnNullability(
  qr: QueryRunner,
  opts: AlignColumnNullabilityOptions,
): Promise<AlignColumnNullabilityResult> {
  if (opts.columns.length === 0) {
    return { aligned: [], skipped: [], backfilled: [] };
  }

  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  for (const c of opts.columns) {
    sql.ident(c.name);
  }

  // @EncryptedAtRest refusal.
  if (opts.entity !== undefined) {
    const encrypted = getEncryptedAtRestMetadata(opts.entity);
    if (encrypted.size > 0) {
      const forbidden = new Set<string>();
      for (const meta of encrypted.values()) {
        forbidden.add(meta.propertyKey);
        forbidden.add(toSnakeCase(meta.propertyKey));
      }
      for (const c of opts.columns) {
        if (forbidden.has(c.name)) {
          throw new Error(
            `[alignColumnNullability] REFUSAL: column '${c.name}' is @EncryptedAtRest on the supplied entity. ` +
              `Encrypted columns MUST NOT be altered via a schema primitive — ` +
              `remediation is an explicit key-rotation operator runbook. ` +
              `See docs/runbooks/encrypted-column-key-rotation.md + ADR-023.`,
          );
        }
      }
    }
  }

  return withDdlSafety(
    qr,
    {
      schema: opts.schema,
      ...(opts.lockTimeoutMs !== undefined && {
        lockTimeoutMs: opts.lockTimeoutMs,
      }),
    },
    async () => {
      const aligned: string[] = [];
      const skipped: string[] = [];
      const backfilled: string[] = [];

      for (const c of opts.columns) {
        const colIdent = sql.ident(c.name);

        // Inspect current nullability.
        const colRows = await executeQueryRowsNormalized<{ is_nullable: string }>(
          qr,
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
          [opts.schema, opts.table, c.name],
        );
        const currentColumn = colRows[0];
        if (!currentColumn) {
          throw new Error(
            `[alignColumnNullability] column '${opts.schema}.${opts.table}.${c.name}' does not exist — ` +
              `use addMissingColumns first, or verify the migration order.`,
          );
        }
        if (currentColumn.is_nullable === 'NO') {
          skipped.push(c.name);
          continue;
        }

        // Count NULL rows.
        const nullCountRows = await executeQueryRowsNormalized<{ count: string }>(
          qr,
          `SELECT COUNT(*)::text AS count FROM "${opts.schema}"."${opts.table}" WHERE "${c.name}" IS NULL`,
        );
        const nullCount = Number.parseInt(nullCountRows[0]?.count ?? '0', 10);

        if (nullCount > 0) {
          if (c.backfillExpr === undefined) {
            throw new Error(
              `[alignColumnNullability] column '${opts.schema}.${opts.table}.${c.name}' has ${nullCount} NULL row(s) ` +
                `but no backfillExpr was supplied. SET NOT NULL would fail on existing data. ` +
                `Provide a backfillExpr (SqlFragment) or clear the NULL rows before re-running.`,
            );
          }
          // Backfill via UPDATE. UPDATE statements DO accept bound
          // params, so we pass through the fragment's params as-is.
          // Placeholders are rewritten to start at $1 since our
          // statement has no other params.
          const updateSql =
            `UPDATE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
            `SET ${colIdent.quoted} = ${c.backfillExpr.sql} ` +
            `WHERE ${colIdent.quoted} IS NULL`;
          await qr.query(updateSql, [...c.backfillExpr.params]);

          // Re-count — fail loudly if the backfill left residual NULLs
          // (e.g. UPDATE expression evaluates to NULL for some rows).
          const recheck = await executeQueryRowsNormalized<{ count: string }>(
            qr,
            `SELECT COUNT(*)::text AS count FROM "${opts.schema}"."${opts.table}" WHERE "${c.name}" IS NULL`,
          );
          const residual = Number.parseInt(recheck[0]?.count ?? '0', 10);
          if (residual > 0) {
            throw new Error(
              `[alignColumnNullability] column '${opts.schema}.${opts.table}.${c.name}': backfill left ${residual} residual NULL row(s). ` +
                `The backfillExpr must produce a non-NULL value for every target row.`,
            );
          }
          backfilled.push(c.name);
        }

        // Apply SET NOT NULL.
        await qr.query(
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
            `ALTER COLUMN ${colIdent.quoted} SET NOT NULL`,
        );
        aligned.push(c.name);
      }

      return { aligned, skipped, backfilled };
    },
  );
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_+/, '')
    .toLowerCase();
}
