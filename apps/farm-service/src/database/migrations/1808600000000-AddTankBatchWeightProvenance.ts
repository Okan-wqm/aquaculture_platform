import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTankBatchWeightProvenance1808600000000
 *
 * Adds `tank_batches."weightProvenance"` (jsonb, nullable) — the source of the
 * row's current `avgWeightG` / `totalBiomassKg`.
 *
 * WHY: biomass in this platform evolved forever as `biomass += fedKg / assumedFCR`
 * and a real weighing changed nothing. Even after the weighing is wired into the
 * tank aggregates, a projected weight and a measured weight are byte-identical
 * numbers in the same two columns — so the platform still could not answer
 * "how wrong is the model?". This column records WHICH writer produced the
 * current aggregates and, for a measurement, the projected value it superseded
 * plus the resulting projection error, making projected-vs-measured error a
 * stored, queryable fact for the first time.
 *
 * NULLABLE ON PURPOSE: rows written before this column existed have no recorded
 * provenance. Back-filling them with a guessed `fcr_projection` label would
 * manufacture a provenance nobody observed — precisely the invented-number
 * problem this column exists to expose. A NULL reads as "unknown source", which
 * is the only true statement about pre-existing rows.
 *
 * current_schema-relative: db-migrate fans farm migrations out with search_path
 * pinned to `farm` and each `tenant_<uuid>`, and `tank_batches` is a PER-TENANT
 * table (its `@Entity()` declares no `schema:`), so the unqualified table name is
 * the only correct target. Idempotent (IF NOT EXISTS), forward-only, blue-green
 * safe (nullable column — old pods that never write it keep working mid-rollout).
 */
export class AddTankBatchWeightProvenance1808600000000 implements MigrationInterface {
  name = 'AddTankBatchWeightProvenance1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "tank_batches"
        ADD COLUMN IF NOT EXISTS "weightProvenance" jsonb
    `);

    // The union tag is the only field every arm carries; constraining it in the
    // database means a writer that invents a third source fails at the row, not
    // silently three screens downstream.
    // Added only when absent, rather than DROP-then-ADD. Dropping a CHECK on a
    // populated table forces a full revalidation scan on re-add and leaves the
    // table unconstrained in between; this guard skips both on replay, where the
    // constraint is already correct. PG has no IF NOT EXISTS for ADD CONSTRAINT,
    // so the duplicate_object arm is the idempotency mechanism.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "tank_batches"
          ADD CONSTRAINT "CHK_tank_batches_weight_provenance_source"
          CHECK (
            "weightProvenance" IS NULL
            OR "weightProvenance"->>'source' IN ('fcr_projection', 'measurement')
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "tank_batches"
        DROP CONSTRAINT IF EXISTS "CHK_tank_batches_weight_provenance_source"
    `);
    await queryRunner.query(`
      ALTER TABLE "tank_batches" DROP COLUMN IF EXISTS "weightProvenance"
    `);
  }
}
