import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forward-only completion of 180610's feed-grain guard. Source-row identity is
 * `fi-migrate-<feed_inventory.id>` in the immutable stock-movement ledger;
 * storage_inventory is only its canonical balance projection.
 */
export class CompleteFeedInventoryLedgerBackfillBySourceRow1809000000000
  implements MigrationInterface
{
  name = 'CompleteFeedInventoryLedgerBackfillBySourceRow1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    const presence: Array<{
      feedInventory: string | null;
      storageInventory: string | null;
    }> = await queryRunner.query(`
      SELECT to_regclass('feed_inventory')::text AS "feedInventory",
             to_regclass('storage_inventory')::text AS "storageInventory"
    `);
    if (!presence[0]?.feedInventory || !presence[0]?.storageInventory) return;

    // The projection key must treat NULL lot as one canonical lot. The legacy
    // nullable-column unique index treats NULLs as distinct and cannot own that
    // identity. Existing ambiguity is an operator-visible conflict, not a row
    // this migration may silently merge.
    const ambiguousProjection: Array<{ count: string; sample: string | null }> =
      await queryRunner.query(`
        SELECT COUNT(*)::text AS count, MIN(key)::text AS sample
          FROM (
            SELECT MIN(id::text) AS key
              FROM storage_inventory
             GROUP BY tenant_id, storage_location_id, item_type, item_id,
                      COALESCE(lot_number, '')
            HAVING COUNT(*) > 1
          ) duplicates
      `);
    if (Number(ambiguousProjection[0]?.count ?? '0') > 0) {
      throw new Error(
        `[feed-ledger-backfill] ${ambiguousProjection[0]?.count} ambiguous storage projection ` +
          `key(s) must be reconciled before row-grain import; sample ` +
          `${ambiguousProjection[0]?.sample}`,
      );
    }
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_storage_inventory_canonical_lot"
        ON storage_inventory (
          tenant_id, storage_location_id, item_type, item_id, COALESCE(lot_number, '')
        )
    `);

    // Full UUID fits the 50-char code column and avoids the old first-eight
    // collision. Reuse an existing legacy location for the same site.
    await queryRunner.query(`
      INSERT INTO storage_locations
        (tenant_id, site_id, name, code, type, capacity_unit, used_capacity,
         is_active, is_deleted, version)
      SELECT DISTINCT fi."tenantId", fi."siteId", 'Ana Yem Deposu',
             'MIG-FEED-' || fi."siteId"::text,
             'warehouse', 'm3', 0, true, false, 1
        FROM feed_inventory fi
        JOIN sites s ON s.id = fi."siteId" AND s."tenantId" = fi."tenantId"
       WHERE fi."quantityKg" > 0
         AND NOT EXISTS (
           SELECT 1 FROM storage_locations sl
            WHERE sl.tenant_id = fi."tenantId"
              AND sl.site_id = fi."siteId"
              AND sl.code IN (
                'MIG-FEED-' || fi."siteId"::text,
                'MIG-FEED-' || left(fi."siteId"::text, 8)
              )
         )
      ON CONFLICT (tenant_id, code) DO NOTHING
    `);

    const unplaceable: Array<{ count: string; sample: string | null }> = await queryRunner.query(`
        SELECT COUNT(*)::text AS count, MIN(fi.id::text) AS sample
          FROM feed_inventory fi
          LEFT JOIN feeds f
            ON f.id = fi."feedId" AND f."tenantId" = fi."tenantId"
          LEFT JOIN sites s
            ON s.id = fi."siteId" AND s."tenantId" = fi."tenantId"
          LEFT JOIN LATERAL (
            SELECT sl.id
              FROM storage_locations sl
             WHERE sl.tenant_id = fi."tenantId"
               AND sl.site_id = fi."siteId"
               AND sl.is_active = true
               AND sl.is_deleted = false
               AND sl.code IN (
                 'MIG-FEED-' || fi."siteId"::text,
                 'MIG-FEED-' || left(fi."siteId"::text, 8)
               )
             ORDER BY (sl.code = 'MIG-FEED-' || fi."siteId"::text) DESC
             LIMIT 1
          ) location ON true
         WHERE fi."quantityKg" > 0
           AND (f.id IS NULL OR s.id IS NULL OR location.id IS NULL)
      `);
    if (Number(unplaceable[0]?.count ?? '0') > 0) {
      throw new Error(
        `[feed-ledger-backfill] ${unplaceable[0]?.count} legacy source row(s) cannot be ` +
          `placed (missing tenant-owned feed/site/location); sample ${unplaceable[0]?.sample}`,
      );
    }

    await queryRunner.query(`
      WITH legacy AS (
        SELECT fi.id AS source_id,
               fi."tenantId" AS tenant_id,
               fi."feedId" AS feed_id,
               fi."quantityKg" AS quantity_kg,
               fi."lotNumber" AS lot_number,
               fi."expiryDate" AS expiry_date,
               fi."receivedDate" AS received_date,
               f.name AS feed_name,
               COALESCE(f.unit, 'kg') AS unit,
               location.id AS location_id
          FROM feed_inventory fi
          JOIN feeds f ON f.id = fi."feedId" AND f."tenantId" = fi."tenantId"
          JOIN LATERAL (
            SELECT sl.id
              FROM storage_locations sl
             WHERE sl.tenant_id = fi."tenantId"
               AND sl.site_id = fi."siteId"
               AND sl.is_active = true
               AND sl.is_deleted = false
               AND sl.code IN (
                 'MIG-FEED-' || fi."siteId"::text,
                 'MIG-FEED-' || left(fi."siteId"::text, 8)
               )
             ORDER BY (sl.code = 'MIG-FEED-' || fi."siteId"::text) DESC
             LIMIT 1
          ) location ON true
         WHERE fi."quantityKg" > 0
      ),
      admitted AS (
        INSERT INTO stock_movements
          (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
           to_location_id, reference, lot_number, expiry_date, idempotency_key,
           performed_by, performed_at)
        SELECT tenant_id, 'in', 'feed', feed_id, feed_name, quantity_kg, unit,
               location_id, 'MIGRATION: feed_inventory source-row reconciliation',
               lot_number, expiry_date, 'fi-migrate-' || source_id,
               '00000000-0000-0000-0000-000000000000', now()
          FROM legacy
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING idempotency_key
      )
      INSERT INTO storage_inventory
        (tenant_id, storage_location_id, item_type, item_id, quantity, unit,
         lot_number, expiry_date, received_date, version, created_by)
      SELECT source.tenant_id, source.location_id, 'feed', source.feed_id,
             source.quantity_kg, source.unit, source.lot_number, source.expiry_date,
             COALESCE(source.received_date::timestamptz, now()), 1,
             '00000000-0000-0000-0000-000000000000'
        FROM legacy source
        JOIN admitted
          ON admitted.idempotency_key = 'fi-migrate-' || source.source_id
      ON CONFLICT (
        tenant_id, storage_location_id, item_type, item_id, COALESCE(lot_number, '')
      ) DO UPDATE
        SET quantity = storage_inventory.quantity + EXCLUDED.quantity,
            updated_at = now()
    `);

    await queryRunner.query(`
      UPDATE feeds f
         SET quantity = totals.quantity,
             status = CASE
               WHEN f.status IN ('expired', 'discontinued') THEN f.status
               WHEN totals.quantity <= 0 THEN 'out_of_stock'
               WHEN totals.quantity <= f."minStock" THEN 'low_stock'
               ELSE 'available'
             END::"farm"."feeds_status_enum"
        FROM (
          SELECT tenant_id, item_id, COALESCE(SUM(quantity), 0) AS quantity
            FROM storage_inventory
           WHERE item_type = 'feed'
           GROUP BY tenant_id, item_id
        ) totals
       WHERE totals.tenant_id = f."tenantId" AND totals.item_id = f.id
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const presence: Array<{ feedInventory: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feed_inventory')::text AS "feedInventory"`,
    );
    if (!presence[0]?.feedInventory) return true;
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
    // Forward-only: source-row movement identities and their balance projection
    // are durable audit facts; deleting them cannot be a rollback strategy.
  }
}
