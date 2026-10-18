import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings existing `tank_batches` rows to the shape the weighing path relies on
 * (FARM-CRITICAL-454 verification). Data only; no schema change.
 *
 * 1. An emptied tank names no batch. `TankBatchService.applyBatchDelta` set
 *    `primaryBatchId = details[0]?.batchId`, which is `undefined` once the tank
 *    empties, and TypeORM's UPDATE skips an undefined property, so an emptied
 *    row kept the departed batch as its primary. The writer now writes `null`;
 *    this clears the rows it left behind. Every reader that takes the primary as
 *    membership (the unit lock, the weighing path, the equipment resolver,
 *    protocol assignment, the meal ledger) saw that batch in a tank with no fish.
 *
 * 2. A row written before `batchDetails[]` became the SSoT (empty details, a
 *    populated total and primary) gets its single share materialized, exactly
 *    as `applyBatchDelta` self-heals it on its next stock change, so it carries
 *    the stamp of step 3.
 *
 * 3. Every share without a `grownThrough` stamp gets the day its row was last
 *    written. `BiomassGrowthApplierService.applyGrowth` now stamps the feeding
 *    day whose growth a share holds, and a weighing dated before it does not
 *    re-base the share (it would discard that growth). A share grown before
 *    this release carries no stamp, but its growth cannot be later than the
 *    row's last write, so that day is a safe bound: an older sample stays
 *    history instead of rolling the ration back.
 *
 * Tenant-relative: db-migrate pins search_path to `farm` or `tenant_<id>`
 * before this runs. `tank_batches` is a per-tenant table, so the body no-ops in
 * schemas that do not own it (e.g. the source `farm` schema). Idempotent: each
 * step touches only rows still in the old shape.
 */
export class BackfillTankBatchPrimaryAndShareStamps1822100000000 implements MigrationInterface {
  name = 'BackfillTankBatchPrimaryAndShareStamps1822100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.tank_batches') IS NULL THEN
          RETURN;
        END IF;

        -- 1. Emptied rows name no batch.
        UPDATE tank_batches tb
        SET "primaryBatchId" = NULL,
            "primaryBatchNumber" = NULL
        WHERE tb."primaryBatchId" IS NOT NULL
          AND tb."totalQuantity" = 0
          AND COALESCE(jsonb_array_length(tb."batchDetails"), 0) = 0;

        -- 2. Pre-SSoT rows: materialize the single share from the totals.
        UPDATE tank_batches tb
        SET "batchDetails" = jsonb_build_array(jsonb_build_object(
              'batchId', tb."primaryBatchId"::text,
              'batchNumber', COALESCE(tb."primaryBatchNumber", ''),
              'quantity', tb."totalQuantity",
              'biomassKg', tb."totalBiomassKg",
              'avgWeightG', round((tb."totalBiomassKg"::numeric * 1000) / tb."totalQuantity", 3),
              'percentageOfTank', 100
            ))
        WHERE tb."primaryBatchId" IS NOT NULL
          AND tb."totalQuantity" > 0
          AND COALESCE(jsonb_array_length(tb."batchDetails"), 0) = 0;

        -- 3. Shares without a growth stamp: the day their row was last written.
        UPDATE tank_batches tb
        SET "batchDetails" = (
          SELECT jsonb_agg(
                   CASE
                     WHEN share.value ? 'grownThrough' THEN share.value
                     ELSE share.value || jsonb_build_object(
                       'grownThrough', to_char(tb."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                     )
                   END
                   ORDER BY share.ordinality
                 )
            FROM jsonb_array_elements(tb."batchDetails") WITH ORDINALITY AS share(value, ordinality)
        )
        WHERE jsonb_array_length(tb."batchDetails") > 0
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(tb."batchDetails") AS unstamped(value)
             WHERE NOT (unstamped.value ? 'grownThrough')
          );
      END
      $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op: a leftover primary on an emptied tank and an unstamped
    // share carry no information worth restoring; the writers keep the new shape.
    await Promise.resolve();
  }
}
