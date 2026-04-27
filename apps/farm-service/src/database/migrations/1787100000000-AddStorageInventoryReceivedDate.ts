import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddStorageInventoryReceivedDate
 * ============================================================================
 *
 * Phase 1.3 hot-fix (closes Orphan 17). The phase-1 FEFO hardening
 * added deterministic tiebreaker ordering on
 *   (expiryDate ASC NULLS LAST, receivedDate ASC, lotNumber ASC)
 * to two queries:
 *
 *   - apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts
 *     (decreaseInventory — FEFO fallback path)
 *   - apps/farm-service/src/storage/event-handlers/feeding-storage-event.handler.ts
 *
 * Both query builders reference `inv.receivedDate`, but the
 * `StorageInventory` entity had no such column. TypeORM's query
 * builder resolves `inv.receivedDate` against the entity metadata
 * at build time; without the column the query would throw
 * `EntityPropertyNotFoundError: Property "receivedDate" was not found
 * in "StorageInventory"` the moment a no-lot movement triggered the
 * FEFO branch. Most real movements carry an explicit lotNumber
 * (operators enter it from the delivery label), so the bug has not
 * surfaced yet — but it is a latent runtime failure for any
 * operator-initiated "pick whatever is expiring first" request.
 *
 * This migration:
 *
 *   1. Adds `received_date TIMESTAMPTZ` to `farm.storage_inventory`.
 *      The timestamp is wall-clock UTC; the FEFO tiebreaker only
 *      compares lots in the same (tenant, location, item) bucket so
 *      timezone drift is irrelevant.
 *
 *   2. Back-fills existing rows with `created_at` — the best proxy
 *      for "when this lot arrived" on a pre-existing row. Without a
 *      backfill, existing rows would be NULL and sort last under
 *      `NULLS LAST`; for historical rows that is acceptable (newer
 *      rows with real timestamps win the tiebreaker) but populating
 *      produces a cleaner ordering immediately.
 *
 *   3. Sets a DEFAULT of `NOW()` on the column so any future INSERT
 *      that forgets to populate it still gets a real timestamp.
 *      TypeORM + application code always sets the value explicitly
 *      (see RecordStockMovementHandler.increaseInventory), but the
 *      DEFAULT defends against direct SQL INSERT, seed scripts, and
 *      any future call path we add without wiring the column.
 */
export class AddStorageInventoryReceivedDate1787100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.storage_inventory
      ADD COLUMN IF NOT EXISTS "received_date" TIMESTAMPTZ DEFAULT NOW()
    `);

    await queryRunner.query(`
      UPDATE farm.storage_inventory
      SET "received_date" = "created_at"
      WHERE "received_date" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.storage_inventory
      DROP COLUMN IF EXISTS "received_date"
    `);
  }
}
