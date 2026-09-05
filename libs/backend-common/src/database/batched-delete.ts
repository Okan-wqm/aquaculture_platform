/**
 * deleteInBatches — age-based disposal that never takes one lock on a
 * whole table (ADMIN-HIGH-013).
 *
 * WHY: `DELETE FROM t WHERE ts < $1` over a year of audit rows holds row
 * locks and WAL for the whole statement, bloats one transaction, and blocks
 * the writers that matter (the ledger the retention window is pruning). The
 * shared helper deletes in bounded batches addressed by `ctid`, each its own
 * statement, until a batch comes back short.
 *
 * The caller passes quoted identifiers it has already validated (the
 * retention authority does) plus a WHERE clause with `$n` placeholders bound
 * to `params`; the batch size is appended as the last parameter.
 */
export interface BatchedDeleteTarget {
  /** Already-quoted `"schema"."table"`. */
  readonly qualifiedTable: string;
  /** Predicate with `$1..$n` placeholders bound to `params`. */
  readonly where: string;
  readonly params: readonly unknown[];
  /** Rows per statement. Default 5 000. */
  readonly batchSize?: number;
  /** Statements per call before stopping (the next run continues). Default 10 000. */
  readonly maxBatches?: number;
}

export interface BatchedDeleteResult {
  readonly deleted: number;
  /** True when `maxBatches` stopped the loop with rows still matching. */
  readonly capped: boolean;
}

export interface BatchedDeleteQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export const DEFAULT_DELETE_BATCH_SIZE = 5_000;
export const DEFAULT_DELETE_MAX_BATCHES = 10_000;

export function batchedDeleteSql(target: BatchedDeleteTarget): string {
  const limitParam = `$${target.params.length + 1}`;
  return (
    `DELETE FROM ${target.qualifiedTable} ` +
    `WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${target.qualifiedTable} WHERE ${target.where} LIMIT ${limitParam})) ` +
    `RETURNING 1`
  );
}

export async function deleteInBatches(
  queryable: BatchedDeleteQueryable,
  target: BatchedDeleteTarget,
): Promise<BatchedDeleteResult> {
  const batchSize = target.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const maxBatches = target.maxBatches ?? DEFAULT_DELETE_MAX_BATCHES;
  const sql = batchedDeleteSql(target);
  const params = [...target.params, batchSize];
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await queryable.query(sql, params);
    const rows = Array.isArray(result) ? result.length : 0;
    deleted += rows;
    if (rows < batchSize) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
