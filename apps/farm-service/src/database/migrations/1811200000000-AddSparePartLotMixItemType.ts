import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddSparePartLotMixItemType1811200000000 (FARM-HIGH-338)
 *
 * WHY: spare parts join the storage ledger as `StorageItemType.SPARE_PART`.
 * `storage_inventory.item_type` and `stock_movements.item_type` are varchar,
 * but `storage_lot_mixes."itemType"` is the Postgres enum
 * `storage_lot_mixes_itemtype_enum` ('feed','chemical','consumable','healthcare').
 * A lotted spare-part receipt that mixes lots would raise 22P02 on the insert.
 *
 * WHAT: grow the enum by 'spare_part'. Enums only GROW (no DROP TYPE, see
 * tests/invariants/no-unguarded-drop-type-in-migration.spec.ts).
 *
 * # Tenant fan-out
 *
 * The type exists in `farm` (Baseline) and, for tenants provisioned through
 * BackfillTenantFarmOperationalTables1800100000000, as a tenant-local copy.
 * db-migrate runs this once per schema with search_path pinned, so each run
 * alters the copy that lives in current_schema() and skips when there is none
 * — a bare ALTER TYPE would throw 42704 on a schema without a local copy (the
 * 2026-06-17 outage shape, see AddCullMortalityAuditEnumValues1801300000000).
 */
export class AddSparePartLotMixItemType1811200000000 implements MigrationInterface {
  name = 'AddSparePartLotMixItemType1811200000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction;
  // the statement is additive and IF NOT EXISTS guarded, so autocommit is
  // idempotent on re-run and on partial failure.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = current_schema()
             AND t.typname = 'storage_lot_mixes_itemtype_enum'
        ) THEN
          ALTER TYPE "storage_lot_mixes_itemtype_enum" ADD VALUE IF NOT EXISTS 'spare_part';
        END IF;
      END
      $$;
    `);
  }

  /**
   * Fail-closed: wherever the enum type exists in the active schema it carries
   * 'spare_part'. Schemas without a local copy pass (they use the `farm` type,
   * which the `farm` run altered).
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ missing: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS missing
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = current_schema()
         AND t.typname = 'storage_lot_mixes_itemtype_enum'
         AND NOT EXISTS (
           SELECT 1 FROM pg_enum e
            WHERE e.enumtypid = t.oid AND e.enumlabel = 'spare_part'
         )
    `);
    return Number(rows[0]?.missing ?? '0') === 0;
  }

  public async down(): Promise<void> {
    // Enum labels are never removed: tenant clones share the type and a
    // narrowing would need the guarded _v2 procedure (plan ARCH-1).
  }
}
