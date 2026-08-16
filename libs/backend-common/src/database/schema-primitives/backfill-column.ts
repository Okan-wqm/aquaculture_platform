/**
 * backfillColumn — chunked Class H data-migration primitive (Phase 3.5).
 * ============================================================================
 *
 * Large-table column backfill without long lock holds. Loops UPDATE ...
 * SET expression WHERE filter LIMIT chunkSize until zero rows are
 * affected OR a safety cap trips. Each chunk runs in its own implicit
 * transaction (the caller decides whether to wrap the loop in BEGIN),
 * so lock hold times scale with chunkSize * row-update-cost, not with
 * total-affected-rows.
 *
 * # When to use
 *
 *   - Backfilling a NOT NULL column that needs more than the single
 *     expression alignColumnNullability accepts (e.g. conditional value
 *     per row).
 *   - Pre-migration data cleaning before alignColumnType crosses an
 *     incompatible cast boundary (Class H — plan v3 R11).
 *   - De-duplicating to make a unique constraint addable.
 *
 * # When NOT to use
 *
 *   - Purely typeshape-compatible alignment (use alignColumnType, which
 *     is a single ALTER).
 *   - Simple literal backfill for NOT NULL (use alignColumnNullability's
 *     backfillExpr — one statement, no chunking needed).
 *
 * # Safety layers
 *
 *   1. sql.ident validates every identifier.
 *   2. Filter + update fragments MUST be SqlFragment — raw strings are
 *      a compile error. Both fragments may carry bound parameters.
 *   3. withDdlSafety envelope. lock_timeout per chunk — a slow chunk
 *      is interrupted rather than stalling concurrent writers.
 *   4. Hard safety cap: maxIterations (default 10_000) prevents a
 *      self-matching predicate from looping forever. If the cap trips,
 *      the primitive throws with a diagnostic.
 *   5. Per-iteration progress callback (optional) so operators can
 *      stream status to logs / dashboards.
 *
 * # Why ctid-based LIMIT?
 *
 * UPDATE with LIMIT isn't portable on PG (LIMIT applies to SELECT, not
 * UPDATE). The canonical chunk pattern is:
 *
 *   UPDATE schema.table
 *      SET <updateExpr>
 *    WHERE ctid = ANY (ARRAY(
 *      SELECT ctid FROM schema.table
 *       WHERE <filterExpr>
 *       LIMIT $chunkSize
 *    ))
 *
 * ctid is PG's physical row address — stable within a transaction,
 * perfect for bounded-chunk UPDATE. The pattern scales to multi-million-
 * row tables without holding long locks.
 */
import type { QueryRunner } from 'typeorm';

import { withDdlSafety } from '../base-migration';
import { queryRowCountNormalized } from '../query-result-normalizer';
import { sql, type SqlFragment } from '../sql-fragments';

export interface BackfillColumnOptions {
  readonly schema: string;
  readonly table: string;
  /**
   * SET clause body — everything after `SET` and before the implicit
   * `WHERE`. Typically a single `col = expression` but can target
   * multiple columns via `col1 = x, col2 = y`.
   */
  readonly updateExpr: SqlFragment;
  /**
   * WHERE predicate selecting rows to update. The predicate MUST
   * narrow — a predicate that matches all rows after update
   * (self-matching) would loop until maxIterations trips.
   */
  readonly filterExpr: SqlFragment;
  /** Default 1000 — tune up for small-row / low-contention tables. */
  readonly chunkSize?: number;
  /** Default 10_000 — safety cap against self-matching predicates. */
  readonly maxIterations?: number;
  /**
   * Called after each chunk. Useful for progress bars in long-running
   * migrations or for streaming to observability. Defaults to a no-op.
   */
  readonly onChunk?: (progress: BackfillProgress) => void | Promise<void>;
  readonly lockTimeoutMs?: number;
}

export interface BackfillProgress {
  readonly iteration: number;
  readonly rowsUpdatedThisChunk: number;
  readonly rowsUpdatedTotal: number;
}

export interface BackfillColumnResult {
  readonly rowsUpdatedTotal: number;
  readonly iterations: number;
  /**
   * True when the primitive exited because a chunk returned 0 rows
   * (filter is empty). False when it exited via maxIterations (indicates
   * a predicate problem — inspect logs).
   */
  readonly completed: boolean;
}

export async function backfillColumn(
  qr: QueryRunner,
  opts: BackfillColumnOptions,
): Promise<BackfillColumnResult> {
  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  const chunkSize = Math.max(1, opts.chunkSize ?? 1000);
  const maxIterations = Math.max(1, opts.maxIterations ?? 10_000);

  return withDdlSafety(
    qr,
    {
      schema: opts.schema,
      ...(opts.lockTimeoutMs !== undefined && {
        lockTimeoutMs: opts.lockTimeoutMs,
      }),
    },
    async () => {
      let rowsUpdatedTotal = 0;
      let iteration = 0;
      let completed = false;

      while (iteration < maxIterations) {
        iteration++;
        // Compose the chunked UPDATE. chunkSize is inlined as an int
        // literal (safe — we clamped the upper range via Math.max).
        // filter + update params are passed through in order: first the
        // updateExpr.params (inside the SET block), then filterExpr.params
        // (inside the ctid subquery).
        const updateSqlRewritten = rewritePlaceholders(opts.updateExpr.sql, 0);
        const filterSqlRewritten = rewritePlaceholders(
          opts.filterExpr.sql,
          opts.updateExpr.params.length,
        );
        // RETURNING 1 — TypeORM's PostgresQueryRunner returns just the
        // rows array from qr.query(); without RETURNING we'd have no
        // portable way to discover the UPDATE's row count. RETURNING 1
        // is single-integer-per-row so the payload stays small.
        const stmt =
          `UPDATE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
          `SET ${updateSqlRewritten} ` +
          `WHERE ctid = ANY (ARRAY( ` +
          `  SELECT ctid FROM ${schemaIdent.quoted}.${tableIdent.quoted} ` +
          `   WHERE ${filterSqlRewritten} ` +
          `   LIMIT ${chunkSize} ` +
          `)) RETURNING 1`;
        const result: unknown = await qr.query(stmt, [
          ...opts.updateExpr.params,
          ...opts.filterExpr.params,
        ]);
        const rowsUpdatedThisChunk = queryRowCountNormalized(result);
        rowsUpdatedTotal += rowsUpdatedThisChunk;

        if (opts.onChunk) {
          await opts.onChunk({
            iteration,
            rowsUpdatedThisChunk,
            rowsUpdatedTotal,
          });
        }

        if (rowsUpdatedThisChunk === 0) {
          completed = true;
          break;
        }
      }

      if (!completed) {
        throw new Error(
          `[backfillColumn] maxIterations (${maxIterations}) reached before chunk returned 0 rows. ` +
            `Total rows updated so far: ${rowsUpdatedTotal}. ` +
            `Inspect your filterExpr — a self-matching predicate (filter still matches the just-updated rows) loops forever. ` +
            `If the table legitimately has > ${maxIterations * chunkSize} rows to backfill, raise maxIterations or narrow the filter.`,
        );
      }

      return { rowsUpdatedTotal, iterations: iteration, completed };
    },
  );
}

/**
 * Rewrite a fragment's $N placeholders to start at offset+1 instead of 1,
 * so two concatenated fragments share a single param list without
 * collisions.
 */
function rewritePlaceholders(sqlText: string, offset: number): string {
  if (offset === 0) return sqlText;
  return sqlText.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
}
