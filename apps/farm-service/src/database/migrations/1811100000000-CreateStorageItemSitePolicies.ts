import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateStorageItemSitePolicies1811100000000 (plan K8 tier 1, FARM-HIGH-336)
 *
 * WHY: the catalog `minStock` is tenant-wide while stock sits per site, so a
 * site that ran dry while another site was full raised nothing. This table
 * holds the per-site DISTRIBUTION minimum of one stock item; the low-stock
 * evaluator compares SUM(storage_inventory) over the site's locations with it.
 *
 * WHAT: per-tenant table (current_schema-relative: `farm` + every
 * tenant_<uuid>), idempotent, forward-only.
 * INVARIANTS enforced here rather than in code:
 *   - one policy per (tenant, site, item_type, item_id) — unique index;
 *   - `min_stock > 0` — a zero minimum means "no policy" and is a delete;
 *   - `created_by` / `updated_by` NOT NULL — every threshold names its author.
 */
export class CreateStorageItemSitePolicies1811100000000 implements MigrationInterface {
  name = 'CreateStorageItemSitePolicies1811100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "storage_item_site_policies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "item_type" character varying(20) NOT NULL,
        "item_id" uuid NOT NULL,
        "min_stock" numeric(15,2) NOT NULL,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        CONSTRAINT "PK_storage_item_site_policies" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_storage_item_site_policies_min_stock_positive" CHECK ("min_stock" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_storage_item_site_policies_site_item"
        ON "storage_item_site_policies" ("tenant_id", "site_id", "item_type", "item_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_storage_item_site_policies_item"
        ON "storage_item_site_policies" ("tenant_id", "item_type", "item_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_item_site_policies"`);
  }
}
