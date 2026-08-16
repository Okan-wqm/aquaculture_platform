import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the immutable stock ledger sufficient to rebuild a depleted FEFO lot.
 *
 * `storage_inventory` is a mutable projection and its zero-quantity row is
 * removed. Feeding corrections restore against the original immutable OUT
 * movement family, so that family must retain both FEFO ordering facts:
 * expiry and arrival. Historical rows are backfilled only when the exact
 * canonical inventory key still exists; otherwise NULL remains an explicit
 * unknown rather than an invented timestamp.
 *
 * Tenant-aware DDL is deliberately schema-unqualified; migration fan-out pins
 * `search_path` to each tenant schema before this class executes.
 */
export class PreserveStockMovementLotReceiptProvenance1809800000000 implements MigrationInterface {
  name = 'PreserveStockMovementLotReceiptProvenance1809800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ADD COLUMN IF NOT EXISTS "received_date" timestamptz`,
    );
    await queryRunner.query(
      `UPDATE "stock_movements" movement
          SET "received_date" = inventory."received_date"
         FROM "storage_inventory" inventory
        WHERE movement."received_date" IS NULL
          AND movement."from_location_id" IS NOT NULL
          AND inventory."tenant_id" = movement."tenant_id"
          AND inventory."storage_location_id" = movement."from_location_id"
          AND inventory."item_type" = movement."item_type"
          AND inventory."item_id" = movement."item_id"
          AND inventory."lot_number" IS NOT DISTINCT FROM movement."lot_number"
          AND inventory."received_date" IS NOT NULL`,
    );
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'stock_movements'
              AND column_name = 'received_date'
              AND data_type = 'timestamp with time zone'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM "stock_movements" movement
             JOIN "storage_inventory" inventory
               ON inventory."tenant_id" = movement."tenant_id"
              AND inventory."storage_location_id" = movement."from_location_id"
              AND inventory."item_type" = movement."item_type"
              AND inventory."item_id" = movement."item_id"
              AND inventory."lot_number" IS NOT DISTINCT FROM movement."lot_number"
            WHERE movement."received_date" IS NOT NULL
              AND inventory."received_date" IS NOT NULL
              AND movement."received_date" <> inventory."received_date"
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "received_date"`);
  }
}
