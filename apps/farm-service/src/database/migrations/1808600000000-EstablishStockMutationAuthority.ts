import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Establishes the database half of the stock mutation authority.
 *
 * - a NULL-safe physical inventory key closes the absent-row race;
 * - allocation/correction coordinates preserve exact lot provenance;
 * - typed operation coordinates bind multi-line mutations to one immutable
 *   canonical request payload;
 * - stock movement facts become append-only;
 * - a tenant-bound self-FK prevents a RETURN from citing another tenant.
 *
 * Duplicate physical rows are not guessed or merged. Deployment stops with
 * the conflicting key so an owner can reconcile the underlying facts first.
 */
export class EstablishStockMutationAuthority1808600000000 implements MigrationInterface {
  name = 'EstablishStockMutationAuthority1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    const relations: Array<{ inventory: string | null; movements: string | null }> =
      await queryRunner.query(
        `SELECT to_regclass('storage_inventory')::text AS inventory,
                to_regclass('stock_movements')::text AS movements`,
      );
    if (!relations[0]?.inventory || !relations[0]?.movements) return;

    await queryRunner.query(`
      DO $$
      DECLARE
        duplicate_key record;
      BEGIN
        SELECT tenant_id,
               storage_location_id,
               item_type,
               item_id,
               NULLIF(btrim(lot_number), '') AS lot_number,
               count(*) AS row_count
          INTO duplicate_key
          FROM storage_inventory
         GROUP BY tenant_id,
                  storage_location_id,
                  item_type,
                  item_id,
                  NULLIF(btrim(lot_number), '')
        HAVING count(*) > 1
         ORDER BY tenant_id, storage_location_id, item_type, item_id
         LIMIT 1;

        IF FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '23505',
            MESSAGE = format(
              'stock mutation authority refused duplicate physical key tenant=%s location=%s type=%s item=%s lot=%s rows=%s',
              duplicate_key.tenant_id,
              duplicate_key.storage_location_id,
              duplicate_key.item_type,
              duplicate_key.item_id,
              coalesce(duplicate_key.lot_number, '<NO_LOT>'),
              duplicate_key.row_count
            );
        END IF;
      END
      $$
    `);

    await queryRunner.query(
      `UPDATE storage_inventory SET lot_number = NULL WHERE btrim(lot_number) = ''`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_618b9a1fc23d4c400d6c91047a"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_inventory_physical_key_v1
        ON storage_inventory (
          tenant_id,
          storage_location_id,
          item_type,
          item_id,
          lot_number
        ) NULLS NOT DISTINCT
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_storage_inventory_quantity_nonnegative_v1'
             AND conrelid = 'storage_inventory'::regclass
        ) THEN
          ALTER TABLE storage_inventory
            ADD CONSTRAINT ck_storage_inventory_quantity_nonnegative_v1
            CHECK (quantity >= 0);
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      ALTER TABLE stock_movements
        ADD COLUMN IF NOT EXISTS received_date timestamptz,
        ADD COLUMN IF NOT EXISTS allocation_family_key varchar(64),
        ADD COLUMN IF NOT EXISTS allocation_root_key varchar(64),
        ADD COLUMN IF NOT EXISTS allocation_slice_index integer,
        ADD COLUMN IF NOT EXISTS source_movement_id uuid,
        ADD COLUMN IF NOT EXISTS operation_type varchar(40),
        ADD COLUMN IF NOT EXISTS operation_id uuid,
        ADD COLUMN IF NOT EXISTS operation_payload_hash char(64),
        ADD COLUMN IF NOT EXISTS operation_item_id uuid
    `);
    await queryRunner.query(`
      UPDATE stock_movements
         SET allocation_root_key = allocation_family_key
       WHERE allocation_family_key IS NOT NULL
         AND allocation_root_key IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_allocation_slice_v1
        ON stock_movements (tenant_id, allocation_family_key, allocation_slice_index)
        WHERE allocation_family_key IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_movements_allocation_root_v1
        ON stock_movements (tenant_id, allocation_root_key, created_at, allocation_slice_index, id)
        WHERE allocation_root_key IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_movements_source_v1
        ON stock_movements (tenant_id, source_movement_id)
        WHERE source_movement_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_operation_item_v1
        ON stock_movements (tenant_id, operation_type, operation_id, operation_item_id)
        WHERE operation_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_movements_operation_v1
        ON stock_movements (tenant_id, operation_type, operation_id)
        WHERE operation_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_tenant_fact_v1
        ON stock_movements (tenant_id, id)
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_quantity_positive_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_quantity_positive_v1
            CHECK (quantity > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_allocation_coordinates_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_allocation_coordinates_v1
            CHECK ((allocation_family_key IS NULL) = (allocation_root_key IS NULL));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_allocation_slice_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_allocation_slice_v1
            CHECK (
              (allocation_family_key IS NULL AND allocation_slice_index IS NULL)
              OR
              (allocation_family_key IS NOT NULL AND allocation_slice_index >= 0)
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_source_return_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_source_return_v1
            CHECK (source_movement_id IS NULL OR movement_type = 'return');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_operation_coordinates_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_operation_coordinates_v1
            CHECK (
              (
                operation_type IS NULL
                AND operation_id IS NULL
                AND operation_payload_hash IS NULL
                AND operation_item_id IS NULL
              ) OR (
                operation_type IS NOT NULL
                AND operation_id IS NOT NULL
                AND operation_payload_hash IS NOT NULL
                AND operation_item_id IS NOT NULL
              )
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_stock_movements_operation_payload_hash_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT ck_stock_movements_operation_payload_hash_v1
            CHECK (
              operation_payload_hash IS NULL
              OR operation_payload_hash ~ '^[0-9a-f]{64}$'
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'fk_stock_movements_source_tenant_v1'
             AND conrelid = 'stock_movements'::regclass
        ) THEN
          ALTER TABLE stock_movements
            ADD CONSTRAINT fk_stock_movements_source_tenant_v1
            FOREIGN KEY (tenant_id, source_movement_id)
            REFERENCES stock_movements (tenant_id, id)
            ON DELETE RESTRICT;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION stock_movement_fact_guard_v1()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        source_fact stock_movements%ROWTYPE;
        returned_quantity numeric;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'stock movement facts are append-only';
        END IF;

        IF NEW.source_movement_id IS NOT NULL THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
              'aquaculture.stock-return/v1:' || NEW.tenant_id::text || ':' || NEW.source_movement_id::text,
              0
            )
          );
          SELECT * INTO source_fact
            FROM stock_movements
           WHERE tenant_id = NEW.tenant_id
             AND id = NEW.source_movement_id;
          IF NOT FOUND
             OR source_fact.movement_type <> 'out'
             OR source_fact.item_type <> NEW.item_type
             OR source_fact.item_id <> NEW.item_id
             OR source_fact.from_location_id IS DISTINCT FROM NEW.to_location_id
             OR source_fact.lot_number IS DISTINCT FROM NEW.lot_number THEN
            RAISE EXCEPTION USING
              ERRCODE = '23514',
              MESSAGE = 'stock RETURN does not match its cited source OUT fact';
          END IF;
          SELECT COALESCE(SUM(quantity), 0)
            INTO returned_quantity
            FROM stock_movements
           WHERE tenant_id = NEW.tenant_id
             AND source_movement_id = NEW.source_movement_id
             AND movement_type = 'return';
          IF returned_quantity + NEW.quantity > source_fact.quantity THEN
            RAISE EXCEPTION USING
              ERRCODE = '23514',
              MESSAGE = 'stock RETURN exceeds the unreturned quantity of its cited source OUT fact';
          END IF;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_stock_movement_fact_guard_v1 ON stock_movements;
      CREATE TRIGGER trg_stock_movement_fact_guard_v1
        BEFORE INSERT OR UPDATE OR DELETE ON stock_movements
        FOR EACH ROW EXECUTE FUNCTION stock_movement_fact_guard_v1()
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Forward-only: removing the stock mutation authority would make physical keys and movement facts ambiguous',
    );
  }
}
