import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconcile the denormalized `tank_batches.currentQuantity` / `currentBiomassKg`
 * mirrors to their authoritative `totalQuantity` / `totalBiomassKg` (ORPHAN-HIGH-276).
 *
 * WHY: `currentQuantity`/`currentBiomassKg` are denormalized MIRRORS of the
 * aggregates — `TankBatchService.applyBatchDelta` (the SSoT writer) always sets
 * `currentQuantity = totalQuantity` (and biomass likewise) after deriving the
 * totals. Before every count mutation routed through applyBatchDelta (#776-779 +
 * #784), the old handlers updated one column without the other, so legacy rows
 * drifted: the reported tank carried `totalQuantity = 719` (correct — the three
 * tanks of batch B-2026-00001 sum to 719+98+83 = 900 = the batch's live
 * currentQuantity) but `currentQuantity = 900` (a stale batch-total leak). The
 * web panel reads `currentQuantity ?? totalQuantity` → showed the wrong 900; the
 * mobile projection reads `totalQuantity` → showed the correct 719. The #786
 * batchDetails backfill did NOT touch these rows (their batchDetails is NULL, not
 * a populated-stale array), so the divergence survived. applyBatchDelta self-heals
 * such a row on its NEXT mutation, but rows never touched again stay wrong.
 *
 * WHAT: set `currentQuantity := totalQuantity` and `currentBiomassKg :=
 * totalBiomassKg` for every row where they disagree (including NULL current* on
 * pre-SSoT rows). totalQuantity is authoritative — it is what applyBatchDelta
 * derives from batchDetails and what the aggregates reconcile to. Idempotent
 * (only divergent rows), per-tenant (search_path-pinned; no-op where the table is
 * absent), down = no-op (restoring the stale mirror carries no information).
 */
export class BackfillTankBatchCurrentQuantityMirror1801800000000 implements MigrationInterface {
  name = 'BackfillTankBatchCurrentQuantityMirror1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.tank_batches') IS NULL THEN
          RETURN;
        END IF;

        UPDATE tank_batches
        SET "currentQuantity" = "totalQuantity",
            "currentBiomassKg" = "totalBiomassKg"
        WHERE "currentQuantity" IS DISTINCT FROM "totalQuantity"
           OR "currentBiomassKg" IS DISTINCT FROM "totalBiomassKg";
      END
      $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op: the denormalized mirror is derived from the totals, so
    // re-introducing the stale pre-backfill values carries no information and
    // applyBatchDelta keeps the invariant (currentQuantity = totalQuantity) going
    // forward.
    await Promise.resolve();
  }
}
