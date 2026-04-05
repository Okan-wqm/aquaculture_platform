import { MigrationInterface, QueryRunner } from 'typeorm';

import { MigrationLogger, assertSafeSchemaName } from '@aquaculture/backend-common';

export class AddPurchaseOrders1772000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddPurchaseOrders1772000000000');
  name = 'AddPurchaseOrders1772000000000';

  private readonly createPurchaseOrdersSQL = `
    CREATE TABLE IF NOT EXISTS "purchase_orders" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "tenant_id" uuid NOT NULL,
      "order_number" varchar(20) NOT NULL,
      "category" varchar(20) NOT NULL DEFAULT 'FEED',
      "supplier_name" varchar(255) NOT NULL,
      "supplier_contact" varchar(255),
      "status" varchar(30) NOT NULL DEFAULT 'DRAFT',
      "expected_delivery_date" date,
      "actual_delivery_date" date,
      "notes" text,
      "total_amount" decimal(15,2),
      "currency" varchar(3) NOT NULL DEFAULT 'NOK',
      "created_by" uuid NOT NULL,
      "approved_by" uuid,
      "is_deleted" boolean NOT NULL DEFAULT false,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "version" integer NOT NULL DEFAULT 1,
      CONSTRAINT "PK_purchase_orders" PRIMARY KEY ("id")
    )
  `;

  private readonly createPurchaseOrderItemsSQL = `
    CREATE TABLE IF NOT EXISTS "purchase_order_items" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "tenant_id" uuid NOT NULL,
      "purchase_order_id" uuid NOT NULL,
      "item_id" uuid NOT NULL,
      "item_name" varchar(255) NOT NULL,
      "item_code" varchar(50),
      "quantity" decimal(15,2) NOT NULL,
      "unit" varchar(20) NOT NULL,
      "unit_price" decimal(15,2),
      "total_price" decimal(15,2),
      "quantity_received" decimal(15,2) NOT NULL DEFAULT 0,
      "is_fully_received" boolean NOT NULL DEFAULT false,
      "notes" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_purchase_order_items" PRIMARY KEY ("id"),
      CONSTRAINT "FK_poi_purchase_order" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE
    )
  `;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create in farm schema (source for new tenant provisioning via LIKE)
    await queryRunner.query(`SET search_path TO "farm", public`);
    await queryRunner.query(this.createPurchaseOrdersSQL);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_id" ON "purchase_orders" ("tenant_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_po_tenant_order_number" ON "purchase_orders" ("tenant_id", "order_number")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_status" ON "purchase_orders" ("tenant_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_category" ON "purchase_orders" ("tenant_id", "category")`);

    await queryRunner.query(this.createPurchaseOrderItemsSQL);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_poi_tenant_po" ON "purchase_order_items" ("tenant_id", "purchase_order_id")`);

    // 2. Create in all existing tenant schemas
    const tenantSchemas = await queryRunner.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);

    for (const row of tenantSchemas) {
      const schema = row.schema_name;
      try {
        await queryRunner.query(`SET search_path TO "${schema}", public`);

        await queryRunner.query(this.createPurchaseOrdersSQL);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_id" ON "purchase_orders" ("tenant_id")`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_po_tenant_order_number" ON "purchase_orders" ("tenant_id", "order_number")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_status" ON "purchase_orders" ("tenant_id", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_po_tenant_category" ON "purchase_orders" ("tenant_id", "category")`);

        await queryRunner.query(this.createPurchaseOrderItemsSQL);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_poi_tenant_po" ON "purchase_order_items" ("tenant_id", "purchase_order_id")`);

        this.logger.log(`Created purchase order tables in ${schema}`);
      } catch (err) {
        this.logger.warn(`Failed to create tables in ${schema}: ${(err as Error).message}`);
      }
    }

    // Reset search_path
    await queryRunner.query(`SET search_path TO public`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop from farm schema
    await queryRunner.query(`SET search_path TO "farm", public`);
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_order_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_orders"`);

    // Drop from all tenant schemas
    const tenantSchemas = await queryRunner.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);

    for (const row of tenantSchemas) {
      const schema = row.schema_name as string;
      assertSafeSchemaName(schema); // defense-in-depth before SQL interpolation
      try {
        await queryRunner.query(`SET search_path TO "${schema}", public`);
        await queryRunner.query(`DROP TABLE IF EXISTS "purchase_order_items"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "purchase_orders"`);
      } catch (err) {
        this.logger.warn(`Failed to drop tables in ${schema}: ${(err as Error).message}`);
      }
    }

    await queryRunner.query(`SET search_path TO public`);
  }
}
