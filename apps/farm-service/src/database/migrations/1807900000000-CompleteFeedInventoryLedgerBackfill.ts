import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CompleteFeedInventoryLedgerBackfill (FARM-CRITICAL-238)
 *
 * `1806100000000` imports legacy `feed_inventory` into the storage ledger, and
 * gates each row on:
 *
 *   AND NOT EXISTS (SELECT 1 FROM storage_inventory si
 *                    WHERE si.item_type = 'feed' AND si.item_id = fi."feedId")
 *
 * That predicate answers a FEED-level question about a ROW-level fact. One
 * storage row for a feed — created by any receipt, at any site, for any lot —
 * suppresses EVERY legacy row of that feed, including rows for other sites and
 * other lots that were never imported. Those kilograms never reach the ledger,
 * `feeds.quantity` is then recomputed as a SUM over what DID arrive, and the
 * shortfall is invisible: no row is reported, nothing fails, and the operator
 * sees a smaller stock than the farm physically holds.
 *
 * ## The fix is to DELETE the guard, not to refine it
 *
 * Exactly-once is already enforced, correctly and at the right grain, by the
 * idempotency key `fi-migrate-<feed_inventory.id>` on `stock_movements`
 * (`ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`), with the inventory
 * insert driven off that statement's RETURNING set. A legacy row that 1806100000000
 * already imported cannot import twice, because its key is taken. The
 * NOT EXISTS was therefore a second, hand-rolled duplicate-suppression mechanism
 * layered on top of a working one — and being coarser, it suppressed rows the key
 * would have admitted.
 *
 * So this migration re-runs the import for every legacy row with stock, with no
 * existence guard at all. Rows already imported no-op on the key; rows the
 * feed-level guard wrongly skipped are imported now.
 *
 * ## Unresolvable rows FAIL CLOSED
 *
 * 1806100000000 also dropped rows silently through its `JOIN storage_locations`:
 * a legacy row whose site has no migration location — or whose feed no longer
 * exists — simply vanished from the result set. Here every such row is counted
 * first and the migration THROWS if any remain, because "some stock could not be
 * placed" is an operator decision, not something a migration may decide by
 * omission.
 *
 * Tenant-aware tables: DDL and DML are schema-unqualified; search_path routes
 * each pass into its own tenant schema.
 */
export class CompleteFeedInventoryLedgerBackfill1807900000000 implements MigrationInterface {
  name = 'CompleteFeedInventoryLedgerBackfill1807900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    // The legacy table is dropped in a later phase; on a schema that has already
    // retired it there is nothing to reconcile.
    const presence: Array<{ fi: string | null; si: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feed_inventory')::text AS fi,
              to_regclass('storage_inventory')::text AS si`,
    );
    if (!presence[0]?.fi || !presence[0]?.si) return;

    // ── 1. Ensure a migration location exists for every site holding stock ──
    //    Same deterministic code as 1806100000000 so a site it already created
    //    is reused rather than duplicated.
    await queryRunner.query(`
      INSERT INTO storage_locations
        (tenant_id, site_id, name, code, type, capacity_unit, used_capacity, is_active, is_deleted, version)
      SELECT DISTINCT
        fi."tenantId", fi."siteId", 'Ana Yem Deposu',
        'MIG-FEED-' || left(fi."siteId"::text, 8),
        'warehouse', 'm3', 0, true, false, 1
      FROM feed_inventory fi
      WHERE fi."quantityKg" > 0
        AND NOT EXISTS (
          SELECT 1 FROM storage_locations sl
          WHERE sl.site_id = fi."siteId"
            AND sl.code = 'MIG-FEED-' || left(fi."siteId"::text, 8)
        )
    `);

    // ── 2. Fail closed on rows that cannot be placed ────────────────────────
    const unplaceable: Array<{ count: string; sample: string | null }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count,
             MIN(fi.id::text) AS sample
        FROM feed_inventory fi
        LEFT JOIN feeds f ON f.id = fi."feedId"
        LEFT JOIN storage_locations sl
          ON sl.site_id = fi."siteId"
         AND sl.code = 'MIG-FEED-' || left(fi."siteId"::text, 8)
       WHERE fi."quantityKg" > 0
         AND (f.id IS NULL OR sl.id IS NULL)
    `);
    const blocked = Number(unplaceable[0]?.count ?? '0');
    if (blocked > 0) {
      throw new Error(
        `[feed-ledger-backfill] ${blocked} legacy feed_inventory row(s) with stock cannot be ` +
          `placed in the storage ledger (missing feed or missing site location; sample id ` +
          `${unplaceable[0]?.sample}). Resolve the referenced feed/site before migrating — ` +
          `importing the remainder would silently understate physical stock.`,
      );
    }

    // ── 3. Import every legacy row; the idempotency key decides exactly-once ─
    const imported: Array<{ count: string }> = await queryRunner.query(`
      WITH legacy AS (
        SELECT fi.id             AS fi_id,
               fi."tenantId"     AS tenant_id,
               fi."feedId"       AS feed_id,
               fi."quantityKg"   AS quantity_kg,
               fi."lotNumber"    AS lot_number,
               fi."expiryDate"   AS expiry_date,
               fi."receivedDate" AS received_date,
               f.name            AS feed_name,
               COALESCE(f.unit, 'kg') AS unit,
               sl.id             AS location_id
          FROM feed_inventory fi
          JOIN feeds f ON f.id = fi."feedId"
          JOIN storage_locations sl
            ON sl.site_id = fi."siteId"
           AND sl.code = 'MIG-FEED-' || left(fi."siteId"::text, 8)
         WHERE fi."quantityKg" > 0
      ),
      ins AS (
        INSERT INTO stock_movements
          (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
           to_location_id, reference, lot_number, expiry_date, idempotency_key,
           performed_by, performed_at)
        SELECT tenant_id, 'in', 'feed', feed_id, feed_name, quantity_kg, unit,
               location_id, 'MIGRATION: feed_inventory -> storage ledger (row-level completion)',
               lot_number, expiry_date, 'fi-migrate-' || fi_id,
               '00000000-0000-0000-0000-000000000000', now()
          FROM legacy
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING item_id, idempotency_key
      ),
      inv AS (
        INSERT INTO storage_inventory
          (tenant_id, storage_location_id, item_type, item_id, quantity, unit,
           lot_number, expiry_date, received_date, version, created_by)
        SELECT l.tenant_id, l.location_id, 'feed', l.feed_id, l.quantity_kg, l.unit,
               l.lot_number, l.expiry_date, COALESCE(l.received_date::timestamptz, now()), 1,
               '00000000-0000-0000-0000-000000000000'
          FROM legacy l
          JOIN ins ON ins.idempotency_key = 'fi-migrate-' || l.fi_id
        -- The canonical key restored in 1807800000000 folds a repeat arrival of
        -- the same (location, feed, lot) into the existing row instead of
        -- splitting the projection.
        ON CONFLICT ("tenant_id", "storage_location_id", "item_type", "item_id",
                     COALESCE("lot_number", ''))
        DO UPDATE SET quantity = storage_inventory.quantity + EXCLUDED.quantity,
                      "updated_at" = now()
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM inv)::text AS count
    `);

    // ── 4. Recompute the roll-up over the now-complete ledger ───────────────
    await queryRunner.query(`
      UPDATE feeds f
         SET quantity = agg.total,
             status = CASE
               WHEN f.status IN ('expired', 'discontinued') THEN f.status
               WHEN agg.total <= 0 THEN 'out_of_stock'
               WHEN agg.total <= f."minStock" THEN 'low_stock'
               ELSE 'available'
             END::"farm"."feeds_status_enum"
        FROM (
          SELECT item_id, COALESCE(SUM(quantity), 0) AS total
            FROM storage_inventory
           WHERE item_type = 'feed'
           GROUP BY item_id
        ) agg
       WHERE agg.item_id = f.id
    `);

    await queryRunner.query(
      `SELECT 'feed-ledger-backfill: ' || $1 || ' previously-skipped row(s) imported' AS summary`,
      [imported[0]?.count ?? '0'],
    );
  }

  /**
   * Every legacy row carrying stock now has its movement in the ledger. This is
   * the assertion 1806100000000 could not make, because under a feed-level guard
   * a skipped row was indistinguishable from an imported one.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const presence: Array<{ fi: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feed_inventory')::text AS fi`,
    );
    if (!presence[0]?.fi) return true;

    const rows: Array<{ missing: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS missing
        FROM feed_inventory fi
       WHERE fi."quantityKg" > 0
         AND NOT EXISTS (
           SELECT 1 FROM stock_movements sm
            WHERE sm.tenant_id = fi."tenantId"
              AND sm.idempotency_key = 'fi-migrate-' || fi.id
         )
    `);
    return Number(rows[0]?.missing ?? '0') === 0;
  }

  public async down(): Promise<void> {
    // Forward-only, for the same reason as 1806100000000: the import is additive
    // and idempotent, and reversing it would destroy operator-visible ledger
    // history. Rollback is a redeploy of the previous release.
  }
}
