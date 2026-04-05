import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Migration: Add Storage Management System
 *
 * Creates 4 new tables:
 * - storage_locations: Physical storage places (warehouses, silos, cold rooms)
 * - consumables: General consumable items (nets, ropes, PPE, tools)
 * - storage_inventory: What items are in which storage location
 * - stock_movements: Audit trail of all stock changes
 *
 * Alters 2 existing tables:
 * - feeds: Add storage condition columns
 * - chemicals: Add storage condition columns
 */
export class AddStorageManagement1771000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddStorageManagement1771000000000');
  name = 'AddStorageManagement1771000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running AddStorageManagement migration in schema:', schema);

    // =========================================================================
    // 1. storage_locations
    // =========================================================================
    const hasStorageLocations = await this.tableExists(queryRunner, 'storage_locations');
    if (!hasStorageLocations) {
      await queryRunner.query(`
        CREATE TABLE "storage_locations" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "site_id" UUID NOT NULL,
          "name" VARCHAR(255) NOT NULL,
          "code" VARCHAR(50) NOT NULL,
          "type" VARCHAR(30) NOT NULL DEFAULT 'warehouse',
          "description" TEXT,
          "capacity" DECIMAL(15,2),
          "capacity_unit" VARCHAR(20) DEFAULT 'm3',
          "used_capacity" DECIMAL(15,2) DEFAULT 0,
          "temperature_min" DECIMAL(5,1),
          "temperature_max" DECIMAL(5,1),
          "humidity_min" DECIMAL(5,1),
          "humidity_max" DECIMAL(5,1),
          "is_active" BOOLEAN NOT NULL DEFAULT true,
          "is_deleted" BOOLEAN NOT NULL DEFAULT false,
          "deleted_at" TIMESTAMPTZ,
          "deleted_by" UUID,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_by" UUID,
          "updated_by" UUID,
          "version" INTEGER NOT NULL DEFAULT 1
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_storage_locations_tenant" ON "storage_locations" ("tenant_id")`);
      await queryRunner.query(`CREATE UNIQUE INDEX "IDX_storage_locations_tenant_code" ON "storage_locations" ("tenant_id", "code")`);
      await queryRunner.query(`CREATE INDEX "IDX_storage_locations_site" ON "storage_locations" ("site_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_storage_locations_type" ON "storage_locations" ("tenant_id", "type")`);
      await queryRunner.query(`CREATE INDEX "IDX_storage_locations_is_deleted" ON "storage_locations" ("is_deleted")`);
      this.logger.log('Created storage_locations table');
    } else {
      this.logger.log('storage_locations table already exists, skipping');
    }

    // =========================================================================
    // 2. consumables
    // =========================================================================
    const hasConsumables = await this.tableExists(queryRunner, 'consumables');
    if (!hasConsumables) {
      await queryRunner.query(`
        CREATE TABLE "consumables" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "name" VARCHAR(255) NOT NULL,
          "code" VARCHAR(50) NOT NULL,
          "category" VARCHAR(30) NOT NULL DEFAULT 'other',
          "description" TEXT,
          "unit" VARCHAR(20) NOT NULL DEFAULT 'pcs',
          "brand" VARCHAR(255),
          "supplier_id" UUID,
          "quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
          "min_stock" DECIMAL(15,2) NOT NULL DEFAULT 0,
          "status" VARCHAR(20) NOT NULL DEFAULT 'available',
          "unit_price" DECIMAL(15,2),
          "currency" VARCHAR(3) NOT NULL DEFAULT 'NOK',
          "storage_temp_min" DECIMAL(5,1),
          "storage_temp_max" DECIMAL(5,1),
          "storage_humidity_min" DECIMAL(5,1),
          "storage_humidity_max" DECIMAL(5,1),
          "storage_requirements" TEXT,
          "notes" TEXT,
          "is_active" BOOLEAN NOT NULL DEFAULT true,
          "is_deleted" BOOLEAN NOT NULL DEFAULT false,
          "deleted_at" TIMESTAMPTZ,
          "deleted_by" UUID,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_by" UUID,
          "updated_by" UUID,
          "version" INTEGER NOT NULL DEFAULT 1
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_consumables_tenant" ON "consumables" ("tenant_id")`);
      await queryRunner.query(`CREATE UNIQUE INDEX "IDX_consumables_tenant_code" ON "consumables" ("tenant_id", "code")`);
      await queryRunner.query(`CREATE INDEX "IDX_consumables_category" ON "consumables" ("tenant_id", "category")`);
      await queryRunner.query(`CREATE INDEX "IDX_consumables_status" ON "consumables" ("tenant_id", "status")`);
      await queryRunner.query(`CREATE INDEX "IDX_consumables_supplier" ON "consumables" ("supplier_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_consumables_is_deleted" ON "consumables" ("is_deleted")`);
      this.logger.log('Created consumables table');
    } else {
      this.logger.log('consumables table already exists, skipping');
    }

    // =========================================================================
    // 3. storage_inventory
    // =========================================================================
    const hasStorageInventory = await this.tableExists(queryRunner, 'storage_inventory');
    if (!hasStorageInventory) {
      await queryRunner.query(`
        CREATE TABLE "storage_inventory" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "storage_location_id" UUID NOT NULL,
          "item_type" VARCHAR(20) NOT NULL,
          "item_id" UUID NOT NULL,
          "quantity" DECIMAL(15,2) NOT NULL DEFAULT 0,
          "unit" VARCHAR(20) NOT NULL,
          "lot_number" VARCHAR(100),
          "expiry_date" DATE,
          "notes" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_by" UUID,
          "updated_by" UUID
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_storage_inventory_tenant" ON "storage_inventory" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_storage_inventory_location" ON "storage_inventory" ("storage_location_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_storage_inventory_item" ON "storage_inventory" ("item_type", "item_id")`);
      await queryRunner.query(`CREATE UNIQUE INDEX "IDX_storage_inventory_unique" ON "storage_inventory" ("tenant_id", "storage_location_id", "item_type", "item_id", COALESCE("lot_number", ''))`);
      this.logger.log('Created storage_inventory table');
    } else {
      this.logger.log('storage_inventory table already exists, skipping');
    }

    // =========================================================================
    // 4. stock_movements
    // =========================================================================
    const hasStockMovements = await this.tableExists(queryRunner, 'stock_movements');
    if (!hasStockMovements) {
      await queryRunner.query(`
        CREATE TABLE "stock_movements" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "movement_type" VARCHAR(20) NOT NULL,
          "item_type" VARCHAR(20) NOT NULL,
          "item_id" UUID NOT NULL,
          "item_name" VARCHAR(255) NOT NULL,
          "quantity" DECIMAL(15,2) NOT NULL,
          "unit" VARCHAR(20) NOT NULL,
          "from_location_id" UUID,
          "to_location_id" UUID,
          "reference" VARCHAR(255),
          "reason" TEXT,
          "performed_by" UUID NOT NULL,
          "performed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_tenant" ON "stock_movements" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_item" ON "stock_movements" ("item_type", "item_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_type" ON "stock_movements" ("tenant_id", "movement_type")`);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_performed_at" ON "stock_movements" ("performed_at")`);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_from_location" ON "stock_movements" ("from_location_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_stock_movements_to_location" ON "stock_movements" ("to_location_id")`);
      this.logger.log('Created stock_movements table');
    } else {
      this.logger.log('stock_movements table already exists, skipping');
    }

    // =========================================================================
    // 5. ALTER feeds - add storage condition columns
    // =========================================================================
    const feedCols = [
      { name: 'storage_temp_min', type: 'DECIMAL(5,1)' },
      { name: 'storage_temp_max', type: 'DECIMAL(5,1)' },
      { name: 'storage_humidity_min', type: 'DECIMAL(5,1)' },
      { name: 'storage_humidity_max', type: 'DECIMAL(5,1)' },
    ];
    for (const col of feedCols) {
      const exists = await this.columnExists(queryRunner, 'feeds', col.name);
      if (!exists) {
        await queryRunner.query(`ALTER TABLE "feeds" ADD COLUMN "${col.name}" ${col.type} DEFAULT NULL`);
        this.logger.log(`Added ${col.name} column to feeds`);
      }
    }
    // storageRequirements already exists on feeds, but let's ensure it allows TEXT length
    // (currently VARCHAR(100), let's alter to TEXT for consistency)
    const hasFeedSR = await this.columnExists(queryRunner, 'feeds', 'storageRequirements');
    if (hasFeedSR) {
      await queryRunner.query(`ALTER TABLE "feeds" ALTER COLUMN "storageRequirements" TYPE TEXT`);
      this.logger.log('Altered feeds.storageRequirements to TEXT');
    }

    // =========================================================================
    // 6. ALTER chemicals - add storage condition columns
    // =========================================================================
    const chemCols = [
      { name: 'storage_temp_min', type: 'DECIMAL(5,1)' },
      { name: 'storage_temp_max', type: 'DECIMAL(5,1)' },
      { name: 'storage_humidity_min', type: 'DECIMAL(5,1)' },
      { name: 'storage_humidity_max', type: 'DECIMAL(5,1)' },
    ];
    for (const col of chemCols) {
      const exists = await this.columnExists(queryRunner, 'chemicals', col.name);
      if (!exists) {
        await queryRunner.query(`ALTER TABLE "chemicals" ADD COLUMN "${col.name}" ${col.type} DEFAULT NULL`);
        this.logger.log(`Added ${col.name} column to chemicals`);
      }
    }
    // storageRequirements already exists on chemicals as VARCHAR(100), alter to TEXT
    const hasChemSR = await this.columnExists(queryRunner, 'chemicals', 'storageRequirements');
    if (hasChemSR) {
      await queryRunner.query(`ALTER TABLE "chemicals" ALTER COLUMN "storageRequirements" TYPE TEXT`);
      this.logger.log('Altered chemicals.storageRequirements to TEXT');
    }

    this.logger.log('AddStorageManagement migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove storage condition columns from chemicals
    for (const col of ['storage_temp_min', 'storage_temp_max', 'storage_humidity_min', 'storage_humidity_max']) {
      const exists = await this.columnExists(queryRunner, 'chemicals', col);
      if (exists) {
        await queryRunner.query(`ALTER TABLE "chemicals" DROP COLUMN "${col}"`);
      }
    }

    // Remove storage condition columns from feeds
    for (const col of ['storage_temp_min', 'storage_temp_max', 'storage_humidity_min', 'storage_humidity_max']) {
      const exists = await this.columnExists(queryRunner, 'feeds', col);
      if (exists) {
        await queryRunner.query(`ALTER TABLE "feeds" DROP COLUMN "${col}"`);
      }
    }

    // Drop tables in reverse dependency order
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_movements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_inventory"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "consumables"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_locations"`);

    this.logger.log('AddStorageManagement migration rollback completed');
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = $1
        AND table_schema = current_schema()
      )
    `, [tableName]);
    return result[0]?.exists === true;
  }

  private async columnExists(queryRunner: QueryRunner, tableName: string, columnName: string): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }
}
