import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill stale single-batch `tank_batches.batchDetails` to the live aggregates.
 *
 * WHY: before the TankBatch SSoT writer (`TankBatchService.applyBatchDelta`) routed
 * every count mutation — allocate/mortality/cull/transfer (#776-779) + harvest
 * (#784) — the mortality/cull/harvest handlers decremented `totalQuantity` /
 * `currentQuantity` but left `batchDetails[]` untouched. The web read model renders
 * `batchDetails[].quantity` while mobile renders the container `totalQuantity`, so a
 * mortality on a stocked tank showed e.g. 900 (stale batchDetails) on the web panel
 * and 719 (live totalQuantity) on mobile — the reported divergence. `applyBatchDelta`
 * self-heals EMPTY `batchDetails` on the next mutation, but stale-POPULATED rows that
 * are never mutated again stay wrong. This one-time backfill reconciles the
 * unambiguous single-batch rows so both surfaces converge without waiting for a
 * future write.
 *
 * SCOPE — single-batch only. A tank holding one batch has a lone detail that MUST
 * equal the tank totals, so the reconciliation is exact and unambiguous. Multi-batch
 * stale rows are deliberately NOT guessed: the migration cannot know which batch a
 * past mortality/cull removed fish from, and inventing a split would corrupt per-batch
 * truth. Those rows are counted and RAISEd as a NOTICE for coordinated domain review
 * (ORPHAN-HIGH-272 follow-up). Idempotent — re-running only touches rows still out of
 * sync.
 *
 * Tenant-relative: db-migrate pins search_path to `farm` or `tenant_<id>` before this
 * runs. `tank_batches` is a per-tenant table, so the body no-ops in schemas that do
 * not own it (e.g. the source `farm` schema).
 */
export class BackfillStaleTankBatchDetails1801700000000 implements MigrationInterface {
  name = 'BackfillStaleTankBatchDetails1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        multi_stale integer;
      BEGIN
        IF to_regclass(current_schema() || '.tank_batches') IS NULL THEN
          RETURN;
        END IF;

        -- Single-batch exact reconciliation: the lone detail carries the live totals.
        -- '||' merges the numeric overrides onto the existing detail, preserving
        -- batchId / batchNumber. Derives avgWeightG + percentageOfTank from the totals.
        UPDATE tank_batches tb
        SET "batchDetails" = jsonb_build_array(
          (tb."batchDetails"->0)
          || jsonb_build_object(
               'quantity', tb."totalQuantity",
               'biomassKg', round(tb."totalBiomassKg"::numeric, 2),
               'avgWeightG', CASE WHEN tb."totalQuantity" > 0
                 THEN round((tb."totalBiomassKg"::numeric * 1000) / tb."totalQuantity", 2)
                 ELSE 0 END,
               'percentageOfTank', 100
             )
        )
        WHERE tb."batchDetails" IS NOT NULL
          AND jsonb_array_length(tb."batchDetails") = 1
          AND (
            COALESCE((tb."batchDetails"->0->>'quantity')::numeric, 0) <> tb."totalQuantity"
            OR round(COALESCE((tb."batchDetails"->0->>'biomassKg')::numeric, 0), 2)
                 <> round(tb."totalBiomassKg"::numeric, 2)
          );

        -- Multi-batch stale rows: ambiguous — surface a count, never guess a split.
        SELECT count(*) INTO multi_stale
        FROM tank_batches tb
        WHERE tb."batchDetails" IS NOT NULL
          AND jsonb_array_length(tb."batchDetails") > 1
          AND (SELECT COALESCE(sum((d->>'quantity')::numeric), 0)
               FROM jsonb_array_elements(tb."batchDetails") d) <> tb."totalQuantity";
        IF multi_stale > 0 THEN
          RAISE NOTICE 'BackfillStaleTankBatchDetails: % multi-batch stale row(s) in schema % left for coordinated review (ORPHAN-HIGH-272)', multi_stale, current_schema();
        END IF;
      END
      $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op: reconciling stale batchDetails to the live totals repairs a
    // data bug. The pre-backfill (wrong) per-batch values carry no information worth
    // restoring, and applyBatchDelta now keeps the invariant going forward.
    await Promise.resolve();
  }
}
