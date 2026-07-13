import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropTankBatchCurrentQuantityMirror — A1 mirror retirement, step 3
 * (ORPHAN-HIGH-353).
 *
 * WHY: the tank fish-count was quad-persisted; `tank_batches.currentQuantity`
 * was a redundant mirror of the batchDetails-derived `totalQuantity` SSoT and
 * its mirror-preferring reads were the production 900-vs-719 divergence. The
 * retirement was blue-green sequenced: (1) every count READ collapsed onto
 * `totalQuantity` (shipped + deployed, guarded by farm-tank-count-ssot.spec);
 * (2) the single writer stopped writing the mirror (this PR's code change);
 * (3) this migration drops the column. `currentBiomassKg` is deliberately NOT
 * dropped — it is the growth-tracked live biomass (feeding accrues weight-gain
 * into it), not a count-style mirror.
 *
 * WHY current_schema-relative: `tank_batches` is a per-tenant table; the
 * db-migrate fan-out runs this migration once against the farm source schema
 * and once per tenant schema. Each pass touches only current_schema() — no
 * cross-schema DDL (the #926 outage class).
 *
 * WHY no data guard: the column is redundant BY DESIGN. Where it diverges from
 * `totalQuantity`, the divergence IS the historical bug — `totalQuantity`
 * (batchDetails-derived, reconciler-verified) is the truth on every
 * environment, so there is nothing to preserve.
 */
export class DropTankBatchCurrentQuantityMirror1805400000000 implements MigrationInterface {
  name = 'DropTankBatchCurrentQuantityMirror1805400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'tank_batches'
            AND column_name = 'currentQuantity'
        ) THEN
          EXECUTE format(
            -- DESTRUCTIVE: ORPHAN-HIGH-353 step 3 — redundant count mirror; the SSoT (totalQuantity, batchDetails-derived) carries the truth on every environment; rollback = re-add the nullable column and re-run the 1801800000000 backfill semantics
            'ALTER TABLE %I.tank_batches DROP COLUMN IF EXISTS "currentQuantity"',
            current_schema()
          );
        ELSE
          RAISE NOTICE 'DropTankBatchCurrentQuantityMirror: %.tank_batches.currentQuantity absent — skipping',
            current_schema();
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement: recreating the mirror column would resurrect the
    // exact quad-persistence this line of work removed. The count truth is the
    // batchDetails-derived totalQuantity; nothing recoverable is lost.
    // Intentionally a no-op.
  }
}
