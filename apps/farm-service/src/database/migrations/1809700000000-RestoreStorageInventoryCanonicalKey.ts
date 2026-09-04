import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RestoreStorageInventoryCanonicalKey (FARM-CRITICAL-240)
 *
 * `storage_inventory` is the physical-stock projection: ONE row per
 * (tenant, location, item type, item, lot). The baseline created its unique
 * index as a plain column tuple:
 *
 *   ("tenant_id", "storage_location_id", "item_type", "item_id", "lot_number")
 *
 * In Postgres two NULLs are never equal, so that index constrains nothing for
 * un-lotted stock — and un-lotted is the common case, since `lotNumber` is
 * optional on every receipt (`receive-delivery.input.ts`). Any number of
 * duplicate rows may therefore exist for the same feed in the same location,
 * and `Feed.quantity` (a SUM over these rows, read by the consumption forecast)
 * silently splits across them.
 *
 * This is a REGRESSION, not an oversight: the superseded pre-baseline migration
 * carried the canonical form —
 * `.archive/…/1771000000000-AddStorageManagement.ts:152` indexes
 * `COALESCE("lot_number", '')`. Squashing into the baseline dropped the
 * expression and nothing noticed, because the weaker index still exists and
 * still has a name.
 *
 * The expression form is restored rather than `NULLS NOT DISTINCT` (PG 15+):
 * it is what this schema used before, it works on every version the platform
 * supports, and it states the domain rule directly — "no lot" is one specific
 * bucket, not an unknown value.
 *
 * ## Existing duplicates are MERGED, not dropped
 *
 * A duplicate pair is not corrupt data; it is the same physical stock counted
 * on two rows. Deleting either loses real kilograms, so the rows are folded
 * into the survivor: quantity summed, the earliest `received_date` kept (it is
 * the FEFO tiebreaker), and the earliest expiry kept (the conservative choice —
 * stock cannot become fresher by being merged). Only then can the unique index
 * be built, and it is built with the merge in the SAME transaction so no window
 * exists where the constraint is absent but the data is already deduped.
 *
 * Tenant-aware table: DDL is schema-unqualified; search_path routes each pass
 * into its own tenant schema.
 */
export class RestoreStorageInventoryCanonicalKey1809700000000 implements MigrationInterface {
  name = 'RestoreStorageInventoryCanonicalKey1809700000000';

  private static readonly CANONICAL_INDEX = 'IDX_storage_inventory_canonical_key';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // 1. Fold duplicates into the earliest row of each canonical group.
    //    `received_date` ASC NULLS LAST picks the row FEFO would have drained
    //    first, so the survivor keeps the stock's real arrival position.
    const merged: Array<{ groups: string; absorbed: string }> = await queryRunner.query(
      `WITH ranked AS (
         SELECT id,
                "tenant_id", "storage_location_id", "item_type", "item_id",
                COALESCE("lot_number", '') AS canonical_lot,
                quantity,
                "received_date",
                "expiry_date",
                ROW_NUMBER() OVER (
                  PARTITION BY "tenant_id", "storage_location_id", "item_type",
                               "item_id", COALESCE("lot_number", '')
                  ORDER BY "received_date" ASC NULLS LAST, "created_at" ASC, id ASC
                ) AS rn
           FROM "storage_inventory"
       ),
       groups AS (
         SELECT "tenant_id", "storage_location_id", "item_type", "item_id", canonical_lot,
                SUM(quantity)      AS total_quantity,
                MIN("expiry_date") AS earliest_expiry,
                COUNT(*)           AS row_count
           FROM ranked
          GROUP BY 1,2,3,4,5
         HAVING COUNT(*) > 1
       ),
       survivors AS (
         SELECT r.id, g.total_quantity, g.earliest_expiry
           FROM ranked r
           JOIN groups g
             ON g."tenant_id" = r."tenant_id"
            AND g."storage_location_id" = r."storage_location_id"
            AND g."item_type" = r."item_type"
            AND g."item_id" = r."item_id"
            AND g.canonical_lot = r.canonical_lot
          WHERE r.rn = 1
       ),
       updated AS (
         UPDATE "storage_inventory" si
            SET quantity = s.total_quantity,
                "expiry_date" = COALESCE(s.earliest_expiry, si."expiry_date"),
                "updated_at" = now()
           FROM survivors s
          WHERE si.id = s.id
         RETURNING si.id
       ),
       removed AS (
         DELETE FROM "storage_inventory" si
          USING ranked r
          WHERE si.id = r.id
            AND r.rn > 1
            AND EXISTS (
              SELECT 1 FROM groups g
               WHERE g."tenant_id" = r."tenant_id"
                 AND g."storage_location_id" = r."storage_location_id"
                 AND g."item_type" = r."item_type"
                 AND g."item_id" = r."item_id"
                 AND g.canonical_lot = r.canonical_lot
            )
         RETURNING si.id
       )
       SELECT (SELECT COUNT(*) FROM updated)::text AS groups,
              (SELECT COUNT(*) FROM removed)::text AS absorbed`,
    );

    // 2. Replace the ineffective index with the canonical one.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_618b9a1fc23d4c400d6c91047a"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${RestoreStorageInventoryCanonicalKey1809700000000.CANONICAL_INDEX}"
         ON "storage_inventory"
         ("tenant_id", "storage_location_id", "item_type", "item_id", COALESCE("lot_number", ''))`,
    );

    await queryRunner.query(
      `SELECT 'storage-inventory-canonical-key: ' || $1 ||
              ' duplicate group(s) merged, ' || $2 || ' row(s) absorbed' AS summary`,
      [merged[0]?.groups ?? '0', merged[0]?.absorbed ?? '0'],
    );
  }

  /**
   * The canonical index exists AND no canonical group has more than one row.
   * Asserting both means a later duplicate cannot be blamed on this migration.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = '${RestoreStorageInventoryCanonicalKey1809700000000.CANONICAL_INDEX}'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM "storage_inventory"
            GROUP BY "tenant_id", "storage_location_id", "item_type", "item_id",
                     COALESCE("lot_number", '')
           HAVING COUNT(*) > 1
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The merge is not reversible — absorbed rows carried no information the
    // survivor does not now hold, but their identities are gone. Only the index
    // shape is restored, which is what a rollback actually needs.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${RestoreStorageInventoryCanonicalKey1809700000000.CANONICAL_INDEX}"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_618b9a1fc23d4c400d6c91047a"
         ON "storage_inventory"
         ("tenant_id", "storage_location_id", "item_type", "item_id", "lot_number")`,
    );
  }
}
