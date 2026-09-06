import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddStockMovementLotReceivedDate (FARM-MEDIUM-254)
 *
 * ## The ghost lot
 *
 * A downward feeding correction returns feed to the lots the original pour
 * actually drew from. By then those `storage_inventory` rows may be gone: a lot
 * drained to zero is deleted, taking its identity with it. The return therefore
 * re-CREATES the row — and it was being born with neither expiry nor arrival
 * date, because the only place those facts survived was the immutable ledger and
 * the ledger was not carrying all of them.
 *
 * `stock_movements` already stores `expiry_date` for exactly this reason (its
 * own docblock says so: "preserves the expiry information even after the
 * inventory row is depleted and removed"). `received_date` was the missing half.
 * The decrement path already computes it — `DrawnLot.receivedDate` is captured
 * from the row it decremented — and then dropped it on the floor for want of a
 * column.
 *
 * ## Why the arrival date is not cosmetic
 *
 * FEFO orders by `(expiryDate NULLS LAST, receivedDate NULLS LAST, lotNumber)`.
 * A returned lot reborn with `receivedDate = now()` sorts as the FRESHEST stock
 * in the location. For un-lotted or un-dated feed — where `receivedDate` IS the
 * tiebreaker — that inverts the picking order: the oldest physical feed in the
 * silo becomes the last thing the engine will feed. Nothing raises; the stock is
 * simply consumed in the wrong order, which is the failure mode FEFO exists to
 * prevent and the one an EU 178/2002 traceability audit asks about.
 *
 * ## Backfill
 *
 * Historical movements can only recover an arrival date where the lot's
 * inventory row still exists; those get it, the rest stay NULL. NULL is a
 * truthful "unknown" here and the return path treats it as such (it falls back
 * to stamping the restore moment) rather than inventing a date. The column is
 * additive and nullable, so the deploy is blue-green safe.
 *
 * Tenant-aware table: DDL is schema-unqualified; search_path routes each pass
 * into its own tenant schema.
 */
export class AddStockMovementLotReceivedDate1809900000000 implements MigrationInterface {
  name = 'AddStockMovementLotReceivedDate1809900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "received_date" date`,
    );

    // Best-effort provenance for movements whose lot row survived. Matched on
    // the canonical inventory key (COALESCE on the lot, since two NULLs are
    // never equal) and only for lot-consuming directions, where `from_location_id`
    // names the row the movement drew from.
    await queryRunner.query(
      `UPDATE "stock_movements" sm
          SET "received_date" = si."received_date"
         FROM "storage_inventory" si
        WHERE sm."received_date" IS NULL
          AND sm."from_location_id" IS NOT NULL
          AND si."tenant_id" = sm."tenant_id"
          AND si."storage_location_id" = sm."from_location_id"
          AND si."item_type" = sm."item_type"
          AND si."item_id" = sm."item_id"
          AND COALESCE(si."lot_number", '') = COALESCE(sm."lot_number", '')
          AND si."received_date" IS NOT NULL`,
    );
  }

  /**
   * The column exists and nothing was invented: every backfilled value still
   * agrees with the inventory row it was copied from. A mismatch would mean the
   * UPDATE matched across canonical keys, which is the one way this migration
   * could corrupt FEFO ordering rather than repair it.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'stock_movements'
              AND column_name = 'received_date'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM "stock_movements" sm
             JOIN "storage_inventory" si
               ON si."tenant_id" = sm."tenant_id"
              AND si."storage_location_id" = sm."from_location_id"
              AND si."item_type" = sm."item_type"
              AND si."item_id" = sm."item_id"
              AND COALESCE(si."lot_number", '') = COALESCE(sm."lot_number", '')
            WHERE sm."received_date" IS NOT NULL
              AND si."received_date" IS NOT NULL
              AND sm."received_date" <> si."received_date"
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "received_date"`);
  }
}
