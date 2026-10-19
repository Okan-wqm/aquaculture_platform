/**
 * Tank membership — the one SQL statement of "this tank holds fish of this
 * batch" (FARM-CRITICAL-454 verification).
 *
 * WHY: TankBatchService (the composition writer) splices a batch out of
 * `batchDetails[]` when its count in the tank reaches zero, and clears the
 * row's `primaryBatchId` when the tank empties. Readers that asked "primary is
 * X, or any detail names X" treated a zero-fish detail or an emptied tank's
 * leftover primary as membership. Readers that need membership take it from
 * here, so the rule is written once.
 *
 * WHAT: a row holds a batch when a `batchDetails[]` entry of that batch has
 * fish in it, or, for a row written before `batchDetails[]` became the SSoT
 * (empty details), when the batch is its primary and the row still has fish.
 *
 * Readers using it: BiomassGrowthApplierService.unitsHoldingBatch (the weighing
 * path) and the regulatory site scope (`regulatory/assembly/batch-site-scope`).
 * Protocol assignment, the FCR target lookup and batch traceability still
 * carry their own "primary, or any detail" predicate; it agrees with this one
 * on every row the composition writer produces.
 */

/**
 * SQL boolean: the `tank_batches` row aliased `tb` holds fish of the batch
 * whose id is the text-typed SQL expression `batchIdText`.
 *
 * Both arguments are SQL expressions written in code (an alias, a column, a
 * bind placeholder), never values: callers bind values as parameters.
 */
export function tankHoldsBatchSql(tb: string, batchIdText: string): string {
  return `(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(${tb}."batchDetails", '[]'::jsonb)) AS held(value)
       WHERE held.value->>'batchId' = ${batchIdText}
         AND (held.value->>'quantity')::numeric > 0
    )
    OR (
      ${tb}."primaryBatchId"::text = ${batchIdText}
      AND COALESCE(jsonb_array_length(${tb}."batchDetails"), 0) = 0
      AND ${tb}."totalQuantity" > 0
    )
  )`;
}
