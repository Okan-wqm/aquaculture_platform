import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the physical inventory key exact for both lotted and un-lotted stock.
 * Duplicate rows are reconciled only when the immutable movement ledger proves
 * the same aggregate balance and their unit/expiry identity is unambiguous.
 */
export class EnforceStorageInventoryPhysicalKey1809700000000 implements MigrationInterface {
  name = 'EnforceStorageInventoryPhysicalKey1809700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
    await queryRunner.query(`LOCK TABLE "storage_inventory" IN ACCESS EXCLUSIVE MODE`);

    await queryRunner.query(`
      DO $$
      DECLARE
        conflict_count integer;
      BEGIN
        WITH duplicate_groups AS (
          SELECT
            "tenant_id",
            "storage_location_id",
            "item_type",
            "item_id",
            "lot_number",
            SUM("quantity")::numeric(15,2) AS projection_quantity,
            COUNT(DISTINCT "unit") AS unit_count,
            COUNT(DISTINCT COALESCE("expiry_date"::text, '<NULL>')) AS expiry_count
          FROM "storage_inventory"
          GROUP BY
            "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
          HAVING COUNT(*) > 1
        ), ledger_balances AS (
          SELECT
            duplicate_groups.*,
            COALESCE(SUM(
              CASE
                WHEN movements."to_location_id" = duplicate_groups."storage_location_id"
                  THEN movements."quantity"
                ELSE 0
              END
              - CASE
                  WHEN movements."from_location_id" = duplicate_groups."storage_location_id"
                    THEN movements."quantity"
                  ELSE 0
                END
            ), 0)::numeric(15,2) AS ledger_quantity
          FROM duplicate_groups
          LEFT JOIN "stock_movements" movements
            ON movements."tenant_id" = duplicate_groups."tenant_id"
           AND movements."item_type" = duplicate_groups."item_type"
           AND movements."item_id" = duplicate_groups."item_id"
           AND movements."lot_number" IS NOT DISTINCT FROM duplicate_groups."lot_number"
           AND (
             movements."from_location_id" = duplicate_groups."storage_location_id"
             OR movements."to_location_id" = duplicate_groups."storage_location_id"
           )
          GROUP BY
            duplicate_groups."tenant_id",
            duplicate_groups."storage_location_id",
            duplicate_groups."item_type",
            duplicate_groups."item_id",
            duplicate_groups."lot_number",
            duplicate_groups.projection_quantity,
            duplicate_groups.unit_count,
            duplicate_groups.expiry_count
        )
        SELECT COUNT(*)::integer
          INTO conflict_count
          FROM ledger_balances
         WHERE unit_count <> 1
            OR expiry_count > 1
            OR projection_quantity <> ledger_quantity;

        IF conflict_count <> 0 THEN
          RAISE EXCEPTION
            'storage_inventory duplicate reconciliation has % unproven physical keys',
            conflict_count;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          ROW_NUMBER() OVER (
            PARTITION BY
              "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
            ORDER BY "created_at" ASC, "id" ASC
          ) AS row_rank,
          SUM("quantity") OVER (
            PARTITION BY
              "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
          )::numeric(15,2) AS reconciled_quantity,
          COUNT(*) OVER (
            PARTITION BY
              "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
          ) AS group_size,
          CASE
            WHEN COUNT("received_date") OVER (
              PARTITION BY
                "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
            ) = COUNT(*) OVER (
              PARTITION BY
                "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
            )
              THEN MIN("received_date") OVER (
                PARTITION BY
                  "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
              )
            ELSE NULL
          END AS first_received_at
        FROM "storage_inventory"
      )
      UPDATE "storage_inventory" inventory
         SET "quantity" = ranked.reconciled_quantity,
             "received_date" = ranked.first_received_at,
             "version" = inventory."version" + 1,
             "updated_at" = NOW()
        FROM ranked
       WHERE inventory."id" = ranked."id"
         AND ranked.row_rank = 1
         AND ranked.group_size > 1
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          ROW_NUMBER() OVER (
            PARTITION BY
              "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
            ORDER BY "created_at" ASC, "id" ASC
          ) AS row_rank
        FROM "storage_inventory"
      )
      DELETE FROM "storage_inventory" inventory
      USING ranked
      WHERE inventory."id" = ranked."id"
        AND ranked.row_rank > 1
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_618b9a1fc23d4c400d6c91047a"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_storage_inventory_lotted_physical_key"
        ON "storage_inventory" (
          "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
        )
        WHERE "lot_number" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_storage_inventory_unlotted_physical_key"
        ON "storage_inventory" (
          "tenant_id", "storage_location_id", "item_type", "item_id"
        )
        WHERE "lot_number" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
    await queryRunner.query(`LOCK TABLE "storage_inventory" IN ACCESS EXCLUSIVE MODE`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "storage_inventory" WHERE "lot_number" IS NULL) THEN
          RAISE EXCEPTION
            'Refusing to weaken the physical-stock key while un-lotted inventory exists';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_storage_inventory_unlotted_physical_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_storage_inventory_lotted_physical_key"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_618b9a1fc23d4c400d6c91047a"
        ON "storage_inventory" (
          "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
        )
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ exact_indexes: string; duplicate_groups: string }> =
      await queryRunner.query(`
        SELECT
          (
            SELECT COUNT(*)
              FROM pg_catalog.pg_indexes
             WHERE schemaname = current_schema()
               AND indexname IN (
                 'uq_storage_inventory_lotted_physical_key',
                 'uq_storage_inventory_unlotted_physical_key'
               )
               AND indexdef LIKE 'CREATE UNIQUE INDEX%'
          )::text AS exact_indexes,
          (
            SELECT COUNT(*)
              FROM (
                SELECT 1
                  FROM "storage_inventory"
                 GROUP BY
                   "tenant_id", "storage_location_id", "item_type", "item_id", "lot_number"
                HAVING COUNT(*) > 1
              ) duplicates
          )::text AS duplicate_groups
      `);
    return rows[0]?.exact_indexes === '2' && rows[0]?.duplicate_groups === '0';
  }
}
