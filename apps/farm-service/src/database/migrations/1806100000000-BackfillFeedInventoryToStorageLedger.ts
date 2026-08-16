import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillFeedInventoryToStorageLedger1806100000000
 *
 * Stock SSoT Phase 1 (feeding-protocol cycle, FARM-HIGH-215/FARM-HIGH-217
 * follow-on; plan ref P-07/P-09): make the storage ledger the single feed
 * stock truth by importing legacy `feed_inventory` balances that have NO
 * storage-ledger presence.
 *
 * # What it does (per schema pass — the data lives in tenant schemas)
 *
 * 1. For every site holding a positive `feed_inventory` balance of a feed the
 *    storage ledger has never seen, idempotently create one default storage
 *    location ("Ana Yem Deposu", deterministic code `MIG-FEED-<site8>`).
 * 2. Import each such `feed_inventory` row as an IN `stock_movements` row
 *    (idempotency key `fi-migrate-<feedInventoryId>` under the existing
 *    partial unique index) carrying lot + expiry, and mirror it into
 *    `storage_inventory` — the inventory insert is driven off the movement
 *    insert's RETURNING set, so a replay (movement conflicts on the key)
 *    inserts NOTHING twice: exactly-once per feed_inventory row.
 * 3. Recompute the `feeds.quantity` roll-up (+ status) for every feed with
 *    ledger presence — this also heals the historical drift caused by
 *    receive-delivery skipping the roll-up before FARM-HIGH-215 was fixed.
 *
 * # What it deliberately does NOT do
 *
 * Feeds that ALREADY have storage-ledger rows are NOT merged: since Phase A
 * both ledgers were written for new movements, but their absolute balances
 * may have diverged historically — blindly adding feed_inventory on top
 * would double-count. Divergent dual-presence feeds are reconciled through
 * the inventory-count workflow (operator-approved), not silently in DDL.
 *
 * Idempotent, forward-only; runs in the farm source pass (template tables,
 * normally empty) and in every tenant pass (real balances).
 */
export class BackfillFeedInventoryToStorageLedger1806100000000 implements MigrationInterface {
  name = 'BackfillFeedInventoryToStorageLedger1806100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // Resolve against the CURRENT pass's search_path; skip schemas that do
    // not carry the storage domain (defensive — both tables ship together).
    const guard: Array<{ fi: string | null; si: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feed_inventory')::text AS fi, to_regclass('storage_inventory')::text AS si`,
    );
    if (!guard[0]?.fi || !guard[0]?.si) {
      return;
    }

    // ── 1. Default migration location per site with orphan feed stock ──────
    // Orphan = positive legacy feed_inventory balance for a feed with ZERO
    // storage_inventory rows in this schema. This is a one-time bootstrap
    // classification; runtime tracking is owned by immutable stock movements.
    await queryRunner.query(`
      INSERT INTO storage_locations
        (tenant_id, site_id, name, code, type, capacity_unit, used_capacity, is_active, is_deleted, version)
      SELECT DISTINCT
        fi."tenantId",
        fi."siteId",
        'Ana Yem Deposu',
        'MIG-FEED-' || left(fi."siteId"::text, 8),
        'warehouse',
        'm3',
        0,
        true,
        false,
        1
      FROM feed_inventory fi
      WHERE fi."quantityKg" > 0
        AND NOT EXISTS (
          SELECT 1 FROM storage_inventory si
          WHERE si.item_type = 'feed' AND si.item_id = fi."feedId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM storage_locations sl
          WHERE sl.site_id = fi."siteId"
            AND sl.code = 'MIG-FEED-' || left(fi."siteId"::text, 8)
        )
    `);

    // ── 2. Exactly-once import: movement first (idempotency key), inventory
    //       driven off the movement insert's RETURNING set ────────────────
    await queryRunner.query(`
      WITH orphan AS (
        SELECT fi.id            AS fi_id,
               fi."tenantId"    AS tenant_id,
               fi."feedId"      AS feed_id,
               fi."quantityKg"  AS quantity_kg,
               fi."lotNumber"   AS lot_number,
               fi."expiryDate"  AS expiry_date,
               fi."receivedDate" AS received_date,
               f.name           AS feed_name,
               COALESCE(f.unit, 'kg') AS unit,
               sl.id            AS location_id
        FROM feed_inventory fi
        JOIN feeds f ON f.id = fi."feedId"
        JOIN storage_locations sl
          ON sl.site_id = fi."siteId"
         AND sl.code = 'MIG-FEED-' || left(fi."siteId"::text, 8)
        WHERE fi."quantityKg" > 0
          AND NOT EXISTS (
            SELECT 1 FROM storage_inventory si
            WHERE si.item_type = 'feed' AND si.item_id = fi."feedId"
          )
      ),
      ins AS (
        INSERT INTO stock_movements
          (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
           to_location_id, reference, lot_number, expiry_date, idempotency_key,
           performed_by, performed_at)
        SELECT tenant_id, 'in', 'feed', feed_id, feed_name, quantity_kg, unit,
               location_id, 'MIGRATION: feed_inventory -> storage ledger',
               lot_number, expiry_date, 'fi-migrate-' || fi_id,
               '00000000-0000-0000-0000-000000000000', now()
        FROM orphan
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING item_id, to_location_id, quantity, lot_number, expiry_date, tenant_id, idempotency_key
      )
      INSERT INTO storage_inventory
        (tenant_id, storage_location_id, item_type, item_id, quantity, unit,
         lot_number, expiry_date, received_date, version, created_by)
      SELECT o.tenant_id, o.location_id, 'feed', o.feed_id, o.quantity_kg, o.unit,
             o.lot_number, o.expiry_date, COALESCE(o.received_date::timestamptz, now()), 1,
             '00000000-0000-0000-0000-000000000000'
      FROM orphan o
      JOIN ins ON ins.idempotency_key = 'fi-migrate-' || o.fi_id
    `);

    // ── 3. Roll-up recompute for every ledger-present feed ─────────────────
    // Also heals the pre-FARM-HIGH-215 receive-delivery drift: quantities
    // received via purchase orders now finally reach feeds.quantity.
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
  }

  public async down(): Promise<void> {
    // Forward-only: the import is additive and idempotent; reversing it would
    // destroy operator-visible ledger history. Blue-green rollback = redeploy
    // the previous release (readers still work — Phase A dual-write kept
    // feed_inventory maintained until Phase 2 retires it).
  }
}
