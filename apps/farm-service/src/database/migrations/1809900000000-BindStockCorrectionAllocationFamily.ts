import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes feeding allocation correction a reconstructable immutable ledger.
 *
 * Every OUT/RETURN slice in one feeding subject shares an allocation family;
 * each RETURN additionally references the exact OUT slice it restores. The
 * composite FK includes tenant identity, so even privileged/manual SQL cannot
 * bind a correction to another tenant's immutable movement.
 */
export class BindStockCorrectionAllocationFamily1809900000000 implements MigrationInterface {
  name = 'BindStockCorrectionAllocationFamily1809900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        ADD COLUMN IF NOT EXISTS "allocation_family_key" varchar(64),
        ADD COLUMN IF NOT EXISTS "source_movement_id" uuid
    `);
    await queryRunner.query(`
      UPDATE "stock_movements"
         SET "allocation_family_key" = regexp_replace("idempotency_key", ':[0-9]+$', '')
       WHERE "allocation_family_key" IS NULL
         AND "movement_type" = 'out'
         AND (
           "idempotency_key" LIKE 'meal-deduct-%'
           OR "idempotency_key" LIKE 'feeding-deduct-%'
         )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_movement_tenant_identity"
        ON "stock_movements" ("tenant_id", id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_stock_movement_allocation_family"
        ON "stock_movements" ("tenant_id", "item_id", "allocation_family_key")
        WHERE "allocation_family_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_stock_movement_source_movement"
        ON "stock_movements" ("tenant_id", "source_movement_id")
        WHERE "source_movement_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        DROP CONSTRAINT IF EXISTS "FK_stock_movement_source_slice",
        ADD CONSTRAINT "FK_stock_movement_source_slice"
          FOREIGN KEY ("tenant_id", "source_movement_id")
          REFERENCES "stock_movements" ("tenant_id", id)
          ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        DROP CONSTRAINT IF EXISTS "CHK_stock_movement_allocation_link",
        ADD CONSTRAINT "CHK_stock_movement_allocation_link" CHECK (
          ("source_movement_id" IS NULL)
          OR (
            "movement_type" = 'return'
            AND "allocation_family_key" IS NOT NULL
          )
        )
    `);
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT (
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'stock_movements'
             AND column_name = 'allocation_family_key'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'stock_movements'
             AND column_name = 'source_movement_id'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'stock_movements'::regclass
             AND conname = 'FK_stock_movement_source_slice'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'stock_movements'::regclass
             AND conname = 'CHK_stock_movement_allocation_link'
        )
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "FK_stock_movement_source_slice"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "CHK_stock_movement_allocation_link"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_stock_movement_source_movement"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_stock_movement_allocation_family"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_stock_movement_tenant_identity"`);
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        DROP COLUMN IF EXISTS "source_movement_id",
        DROP COLUMN IF EXISTS "allocation_family_key"
    `);
  }
}
