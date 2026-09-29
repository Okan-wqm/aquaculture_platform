import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MoveSparePartStockToLedger1811300000000 (FARM-HIGH-338)
 *
 * WHY: `spare_parts.quantity` was a bare counter. Every writer (manual movement,
 * bulk stock-in, work-order completion) mutated it and persisted no movement
 * row, and `location` was free-text jsonb `{warehouse, shelf, bin}` — not a
 * storage location — so spare-part stock had no site and no audit trail.
 * Spare parts now live in the ONE storage ledger (`storage_inventory` +
 * `stock_movements`, item_type 'spare_part') at a real `storage_locations` row.
 *
 * WHAT (blue-green, forward-only):
 *   1. `spare_parts."storageLocationId"` uuid NULL + FK → storage_locations(id).
 *      Nullable first: a part with no stock needs no location yet.
 *   2. Map existing parts: `location->>'warehouse'` names a location of the same
 *      tenant by code (case-insensitive) or, when no code matches, by a UNIQUE
 *      name. Ambiguous or absent → left unmapped.
 *   3. FAIL CLOSED: a part with quantity > 0 that is still unmapped aborts the
 *      migration and names every such part, so the operator maps it (sets the
 *      warehouse text to the location code) before deploying. Importing the rest
 *      would silently understate spare-part stock.
 *   4. Import each mapped part's quantity as one opening IN movement
 *      (idempotency key `sp-migrate-<id>`, exactly-once) plus its
 *      storage_inventory row.
 *
 * FREEZE (V-B1-7 of the B1a-1 verifier round), created BEFORE steps 2–4 in
 * the same transaction: a BEFORE INSERT / UPDATE OF quantity trigger rejects
 * any write that changes `spare_parts.quantity`. WHY: the import is a
 * one-time snapshot, and a selective droplet deploy (explicit service list)
 * runs db-migrate while the OLD farm-service still serves — it keeps writing
 * the counter (create with quantity, stock movement, work-order completion)
 * until its container is recreated, and after a manual image rollback it
 * would write a counter nobody reads. Without the freeze those writes are
 * lost silently; with it they fail loudly and roll back (the operator
 * retries on the new release, whose writes go through the ledger). The
 * ALTER in step 1 already holds the table's ACCESS EXCLUSIVE lock, so every
 * old write either committed before the snapshot below reads the table (and
 * is imported) or runs after this commit (and is refused): no write falls
 * between. The application never writes the column (`legacyQuantity` is
 * `insert: false, update: false`); an insert of 0 (the default) passes.
 *
 * NOT done here: `spare_parts.quantity` / `status` stop being written by the
 * application in the same PR and are read from the ledger; dropping the two
 * columns, the trigger and its function is plan PR-A4 (the destructive
 * contract step after this runs live).
 *
 * Tenant-aware: schema-unqualified DDL/DML; search_path routes each pass.
 */
/** Trigger + function that reject every write changing `spare_parts.quantity`. */
export const LEGACY_QUANTITY_FREEZE_TRIGGER = 'trg_spare_parts_legacy_quantity_frozen';
export const LEGACY_QUANTITY_FREEZE_FUNCTION = 'spare_parts_legacy_quantity_frozen';

export class MoveSparePartStockToLedger1811300000000 implements MigrationInterface {
  name = 'MoveSparePartStockToLedger1811300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    // ── 1. Real location reference (nullable, FK) ───────────────────────────
    await queryRunner.query(
      `ALTER TABLE "spare_parts" ADD COLUMN IF NOT EXISTS "storageLocationId" uuid`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = current_schema()
            AND c.conname = 'FK_spare_parts_storage_location'
        ) THEN
          ALTER TABLE "spare_parts"
            ADD CONSTRAINT "FK_spare_parts_storage_location"
            FOREIGN KEY ("storageLocationId") REFERENCES "storage_locations"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_spare_parts_tenant_storage_location"
        ON "spare_parts" ("tenantId", "storageLocationId")
    `);

    // ── 1b. Freeze the legacy counter before the snapshot (V-B1-7) ──────────
    // Unqualified: the function and trigger land in the schema this pass
    // runs in (farm and every tenant_<uuid>), next to the table they guard.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${LEGACY_QUANTITY_FREEZE_FUNCTION}()
      RETURNS trigger AS $fn$
      BEGIN
        IF (TG_OP = 'INSERT' AND COALESCE(NEW.quantity, 0) <> 0)
           OR (TG_OP = 'UPDATE' AND NEW.quantity IS DISTINCT FROM OLD.quantity) THEN
          RAISE EXCEPTION
            'spare_parts.quantity is frozen: spare-part stock lives in the storage ledger (FARM-HIGH-338); record a stock movement instead'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS ${LEGACY_QUANTITY_FREEZE_TRIGGER} ON "spare_parts"`,
    );
    await queryRunner.query(`
      CREATE TRIGGER ${LEGACY_QUANTITY_FREEZE_TRIGGER}
        BEFORE INSERT OR UPDATE OF quantity ON "spare_parts"
        FOR EACH ROW EXECUTE FUNCTION ${LEGACY_QUANTITY_FREEZE_FUNCTION}()
    `);

    // ── 2. Deterministic mapping from the free-text warehouse ───────────────
    // A code match outranks a name match; within the winning rank the match
    // must be unique, otherwise the part stays unmapped (no guessing).
    await queryRunner.query(`
      WITH parts AS (
        SELECT sp.id, sp."tenantId" AS tenant_id,
               NULLIF(btrim(sp.location->>'warehouse'), '') AS warehouse
          FROM spare_parts sp
         WHERE sp."storageLocationId" IS NULL
      ),
      matches AS (
        SELECT p.id AS part_id, sl.id AS location_id,
               CASE WHEN lower(sl.code) = lower(p.warehouse) THEN 1 ELSE 2 END AS match_rank
          FROM parts p
          JOIN storage_locations sl
            ON sl.tenant_id = p.tenant_id
           AND sl.is_deleted = false
           AND p.warehouse IS NOT NULL
           AND (lower(sl.code) = lower(p.warehouse) OR lower(sl.name) = lower(p.warehouse))
      ),
      best AS (
        SELECT part_id, MIN(match_rank) AS match_rank FROM matches GROUP BY part_id
      ),
      resolved AS (
        SELECT m.part_id, MIN(m.location_id::text)::uuid AS location_id, COUNT(*) AS candidates
          FROM matches m
          JOIN best b ON b.part_id = m.part_id AND b.match_rank = m.match_rank
         GROUP BY m.part_id
      )
      UPDATE spare_parts sp
         SET "storageLocationId" = r.location_id
        FROM resolved r
       WHERE r.part_id = sp.id
         AND r.candidates = 1
    `);

    // ── 3. Fail closed on stock that cannot be placed ───────────────────────
    const unplaceable: Array<{ id: string; name: string }> = await queryRunner.query(`
      SELECT sp.id::text AS id, sp.name AS name
        FROM spare_parts sp
       WHERE sp.quantity > 0
         AND sp."storageLocationId" IS NULL
       ORDER BY sp.name, sp.id
    `);
    if (unplaceable.length > 0) {
      const listed = unplaceable.map((part) => `${part.id} (${part.name})`).join(', ');
      throw new Error(
        `[spare-part-ledger] ${unplaceable.length} spare part(s) hold stock but have no ` +
          `mappable storage location: ${listed}. Set each part's warehouse to the CODE of ` +
          `the storage location that physically holds it, then re-run the migration — ` +
          `importing the rest would silently understate spare-part stock.`,
      );
    }

    // ── 4. Opening balance per part; the idempotency key decides exactly-once ─
    await queryRunner.query(`
      WITH opening AS (
        SELECT sp.id AS part_id, sp."tenantId" AS tenant_id, sp.name AS part_name,
               sp.unit AS unit, sp.quantity AS quantity, sp."storageLocationId" AS location_id
          FROM spare_parts sp
         WHERE sp.quantity > 0
           AND sp."storageLocationId" IS NOT NULL
      ),
      ins AS (
        INSERT INTO stock_movements
          (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
           to_location_id, reference, idempotency_key, performed_by, performed_at)
        SELECT tenant_id, 'in', 'spare_part', part_id, part_name, quantity, unit,
               location_id, 'MIGRATION: spare_parts.quantity -> storage ledger (opening balance)',
               'sp-migrate-' || part_id, '00000000-0000-0000-0000-000000000000', now()
          FROM opening
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING item_id
      )
      INSERT INTO storage_inventory
        (tenant_id, storage_location_id, item_type, item_id, quantity, unit,
         received_date, version, created_by)
      SELECT o.tenant_id, o.location_id, 'spare_part', o.part_id, o.quantity, o.unit,
             now(), 1, '00000000-0000-0000-0000-000000000000'
        FROM opening o
        JOIN ins ON ins.item_id = o.part_id
      ON CONFLICT ("tenant_id", "storage_location_id", "item_type", "item_id",
                   COALESCE("lot_number", ''))
      DO UPDATE SET quantity = storage_inventory.quantity + EXCLUDED.quantity,
                    "updated_at" = now()
    `);
  }

  /**
   * Every spare part that held stock has its opening movement in the ledger,
   * and the legacy counter is frozen. Holds trivially on an empty table and on
   * a table whose parts hold no stock (the freeze is still required).
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ missing: string; frozen: boolean }> = await queryRunner.query(`
      SELECT
        (SELECT COUNT(*)::text
           FROM spare_parts sp
          WHERE sp.quantity > 0
            AND NOT EXISTS (
              SELECT 1 FROM stock_movements sm
               WHERE sm.tenant_id = sp."tenantId"
                 AND sm.idempotency_key = 'sp-migrate-' || sp.id
            )) AS missing,
        EXISTS (
          SELECT 1
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema()
             AND c.relname = 'spare_parts'
             AND t.tgname = '${LEGACY_QUANTITY_FREEZE_TRIGGER}'
             AND NOT t.tgisinternal
        ) AS frozen
    `);
    return Number(rows[0]?.missing ?? '0') === 0 && rows[0]?.frozen === true;
  }

  public async down(): Promise<void> {
    // Forward-only: reversing the import would erase ledger history that
    // operators have since moved against. Rollback is a redeploy of the
    // previous release; the added column is ignored by old code.
  }
}
