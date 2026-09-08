import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LinkTankOperationToHarvestRecord (FARM-HIGH-198)
 *
 * ## The ledger row nothing could find
 *
 * Recording a harvest writes two rows: the `harvest_records` row that is the
 * SSoT, and a `tank_operations` row of type `harvest` that the operations
 * ledger renders — batch history, tank operations, the mobile stock-event
 * summary, the daily ops counts and the FCR calculation all read it.
 *
 * Cancelling a harvest reverses the stock correctly (batch aggregates, tank
 * composition through `applyBatchDelta`, tank biomass) and flips the record to
 * CANCELLED. The ledger row it wrote is left standing, `isDeleted = false`, so
 * every one of those consumers keeps counting a removal that was undone.
 *
 * The reason it was left standing is structural: `tank_operations` carried no
 * reference to the harvest record, so a cancel had no way to name its own row.
 * Matching on (tenant, tank, batch, date, quantity) picks the wrong row for two
 * same-day harvests of equal size, which is a guess where a foreign key
 * belongs. This adds the key.
 *
 * ## Backfill
 *
 * Historical pairs are recovered only where the identification is certain: the
 * operation matches exactly one record on that key AND that record matches
 * exactly one operation. Anything ambiguous stays NULL, and a cancel of such a
 * harvest reports that it cannot identify the row rather than soft-deleting a
 * row it guessed at. NULL is a truthful "unknown" here.
 *
 * The column is additive and nullable, so the deploy is blue-green safe.
 *
 * Tenant-aware table: DDL is schema-unqualified; search_path routes each pass
 * into its own tenant schema.
 */
export class LinkTankOperationToHarvestRecord1810300000000 implements MigrationInterface {
  name = 'LinkTankOperationToHarvestRecord1810300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `ALTER TABLE "tank_operations" ADD COLUMN IF NOT EXISTS "harvestRecordId" uuid`,
    );

    // Partial index: only harvest operations carry the link, and the cancel
    // path looks the row up by it.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tank_operations_harvestRecordId"
         ON "tank_operations" ("harvestRecordId")
      WHERE "harvestRecordId" IS NOT NULL`,
    );

    // Recover historical pairs ONLY where the match is one-to-one in both
    // directions. A same-day pair of equal-sized harvests on one batch+tank is
    // exactly the case a heuristic would mis-link, so it is left NULL instead.
    await queryRunner.query(
      `WITH candidate AS (
         SELECT o."id" AS op_id, h."id" AS hr_id
           FROM "tank_operations" o
           JOIN "harvest_records" h
             ON h."tenantId" = o."tenantId"
            AND h."batchId" = o."batchId"
            AND h."tankId" = o."tankId"
            AND h."harvestDate" = o."operationDate"
            AND h."quantityHarvested" = o."quantity"
          WHERE o."operationType" = 'harvest'
            AND o."harvestRecordId" IS NULL
       ),
       unambiguous AS (
         SELECT op_id, hr_id
           FROM candidate
          WHERE op_id IN (SELECT op_id FROM candidate GROUP BY op_id HAVING COUNT(*) = 1)
            AND hr_id IN (SELECT hr_id FROM candidate GROUP BY hr_id HAVING COUNT(*) = 1)
       )
       UPDATE "tank_operations" o
          SET "harvestRecordId" = u.hr_id
         FROM unambiguous u
        WHERE o."id" = u.op_id`,
    );
  }

  /**
   * The column and its index exist, and no backfilled link crosses a tenant,
   * batch or tank boundary. A crossed link would mean the UPDATE matched beyond
   * the identifying key — the one way this migration could make a cancel
   * withdraw the WRONG ledger row instead of its own.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'tank_operations'
              AND column_name = 'harvestRecordId'
         )
         AND EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND tablename = 'tank_operations'
              AND indexname = 'IDX_tank_operations_harvestRecordId'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM "tank_operations" o
             JOIN "harvest_records" h ON h."id" = o."harvestRecordId"
            WHERE o."harvestRecordId" IS NOT NULL
              AND (
                h."tenantId" <> o."tenantId"
                OR h."batchId" <> o."batchId"
                OR h."tankId" IS DISTINCT FROM o."tankId"
              )
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tank_operations_harvestRecordId"`);
    await queryRunner.query(
      `ALTER TABLE "tank_operations" DROP COLUMN IF EXISTS "harvestRecordId"`,
    );
  }
}
