import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddFarmStockBatchSnapshotSpecies1805200000000
 *
 * Phase 6 (FARM-HIGH-214): farm_stock_batch_snapshots gains speciesId +
 * speciesName. The inventory read model is the mobile client's tank/stock
 * SSoT, and regulatory field capture (escape incidents in particular) must
 * know the species actually stocked in the selected pen without a second
 * online round-trip — offline-first capture reads it from the cached
 * inventory.
 *
 * Blue-green safe: both columns nullable; the projection service refreshes
 * snapshots wholesale (DELETE + INSERT per container), so new writes populate
 * them immediately, and a one-shot backfill join fills existing rows from
 * batches_v2 + species so there is no null-species window for standing stock.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class AddFarmStockBatchSnapshotSpecies1805200000000 implements MigrationInterface {
  name = 'AddFarmStockBatchSnapshotSpecies1805200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      ALTER TABLE "farm_stock_batch_snapshots"
        ADD COLUMN IF NOT EXISTS "speciesId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "farm_stock_batch_snapshots"
        ADD COLUMN IF NOT EXISTS "speciesName" varchar(255)
    `);

    // One-shot backfill for standing snapshots: species is resolved through
    // the batch (batches_v2.speciesId → species.commonName). Rows whose batch
    // has been deleted stay null and heal on the next projection refresh.
    await queryRunner.query(`
      UPDATE "farm_stock_batch_snapshots" s
      SET
        "speciesId" = b."speciesId",
        "speciesName" = sp."commonName"
      FROM "batches_v2" b
      LEFT JOIN "species" sp
        ON sp."id" = b."speciesId" AND sp."tenantId" = b."tenantId"
      WHERE b."tenantId" = s."tenantId"
        AND b."id" = s."batchId"
        AND s."speciesId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "farm_stock_batch_snapshots" DROP COLUMN IF EXISTS "speciesName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "farm_stock_batch_snapshots" DROP COLUMN IF EXISTS "speciesId"`,
    );
  }
}
