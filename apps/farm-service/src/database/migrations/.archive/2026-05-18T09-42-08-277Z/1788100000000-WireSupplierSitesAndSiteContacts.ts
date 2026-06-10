import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
  tableExists as backendTableExists,
} from '@aquaculture/backend-common/database';

/**
 * WireSupplierSitesAndSiteContacts1788100000000
 * ============================================================================
 *
 * Scope A Phase 4.4.1 — closes FARM-ORPHAN-001, FARM-ORPHAN-002, and
 * FARM-ORPHAN-003. Creates the two tables documented in
 * `docs/illustrator/farm-modulu-sema-gorsel.md:1281,1344` per tenant
 * schema (the same schema-per-tenant model used by every other
 * farm-service migration).
 *
 *   - `supplier_sites` — N:M between `suppliers` and `sites`. The
 *     CreateSupplier form's `approvedSites[]` field has been silently
 *     discarded since the form was first added because the table did
 *     not exist; this migration is the prerequisite to wiring that
 *     write path (Phase 4.4.2).
 *
 *   - `site_contacts` — Per-site contact people (Genel Müdür, Tesis
 *     Müdürü, etc). The SiteFormModal's contact rows have similarly
 *     been discarded; Phase 4.4.3 wires them.
 *
 * Both entity files (`supplier-site.entity.ts`, `site-contact.entity.ts`)
 * have existed in source for some time but were marked
 *   "Orphan entity - not registered in any module's forFeature()"
 * in their docblocks. The schema-manager service had a long
 * INFRA-CRITICAL-019 comment block explicitly excluding them from
 * `MODULE_SCHEMAS[farm].tables` for that reason. That comment is
 * removed in the same commit that lands this migration so the two
 * states (DDL exists + module wiring exists + registry entries
 * exist) move together.
 *
 * # Per-tenant schema strategy
 *
 * Every other farm-service table is created by a migration that
 * `pinSearchPath(queryRunner, 'farm')` and creates the table in the
 * pinned schema. The migration runner then walks every
 * `tenant_<hex16>` schema and re-runs the same migration body in
 * each tenant's search_path — so the bodies stay tenant-agnostic.
 * `current_schema()` reports back which schema the body is currently
 * running in for log tagging only.
 *
 * # Idempotency
 *
 * Both tables are guarded with `tableExists()` (CURRENT_SCHEMA-scoped
 * `information_schema.tables` lookup) so a re-run on a partially-
 * migrated environment is safe. Indexes are created via
 * `CREATE INDEX IF NOT EXISTS` for the same reason.
 *
 * # FK semantics
 *
 * Both tables FK into `farm.suppliers(id)` (supplier_sites) and
 * `farm.sites(id)` (both) with `ON DELETE CASCADE`. The CASCADE
 * mirrors the entity decorators (`@ManyToOne(..., { onDelete: 'CASCADE' })`)
 * and matches the operator intent: deleting a supplier or site
 * removes its junction rows; you do not want orphan supplier_sites
 * pointing at a deleted supplier.
 *
 * # Partial unique index on site_contacts
 *
 * The illustrator spec calls out "yalnızca bir primary contact per
 * site". A regular UNIQUE on `(siteId, isPrimary)` would only
 * forbid two `(site, true)` rows but also forbid two `(site, false)`
 * rows — wrong. The PostgreSQL idiom is a partial unique index:
 *
 *   CREATE UNIQUE INDEX ... ON site_contacts (siteId)
 *     WHERE isPrimary = true
 *
 * which allows N non-primary contacts per site but only one primary.
 * The Phase 4.4.3 handler additionally pre-checks for clearer error
 * messages, but the partial index is the authoritative gate at the
 * DB level.
 *
 * # Defensive notes for rollback
 *
 * `down()` drops both tables. By the time this migration is rolled
 * back in any environment, callers using `approvedSites[]` /
 * `contacts` mutations would 500 — but those callers cannot exist
 * before Phase 4.4.2/4.4.3 ship, and a Scope A rollback would
 * always also revert those phases. The down() is therefore safe in
 * practice and the standard "drop in reverse dependency order"
 * pattern.
 */
export class WireSupplierSitesAndSiteContacts1788100000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'WireSupplierSitesAndSiteContacts1788100000000',
  );
  name = 'WireSupplierSitesAndSiteContacts1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    const schema = await queryRunner.query('SELECT current_schema()');
    this.logger.log(
      'Running WireSupplierSitesAndSiteContacts in schema:',
      schema,
    );

    // -----------------------------------------------------------------
    // 1. supplier_sites
    // -----------------------------------------------------------------
    // Wave 4-A.2 Dalga 3 bootstrap-restoration guard: the FK clauses
    // below reference `suppliers` and `sites`. Both are produced by
    // the source-schema baseline (or sibling per-tenant migrations on
    // tenant fan-out). On fresh-volume bootstrap that runs this
    // migration before the suppliers table lands, the CREATE TABLE
    // crashes on the FK clause. Skip cleanly when suppliers is absent
    // — the parent migration that creates it will run later, and a
    // re-run of the migration list (idempotent path) will land the
    // junction table when both parents are present.
    const hasSuppliers = await backendTableExists(queryRunner, 'suppliers');
    if (!hasSuppliers) {
      this.logger.log(
        'Skipping supplier_sites/site_contacts CREATE — suppliers table not present on this DB (installed by sibling baseline migration; junction tables land on re-run)',
      );
      return;
    }

    const hasSupplierSites = await this.tableExists(queryRunner, 'supplier_sites');
    if (!hasSupplierSites) {
      // CREATE TABLE + indexes ship in ONE query chunk so the
      // migration-sql-lint R3 grandfather kicks in (the table is
      // empty at index-creation time, no ACCESS EXCLUSIVE concern).
      await queryRunner.query(`
        CREATE TABLE "supplier_sites" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenantId" UUID NOT NULL,
          "supplierId" UUID NOT NULL,
          "siteId" UUID NOT NULL,
          "isPreferred" BOOLEAN NOT NULL DEFAULT false,
          "notes" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "createdBy" UUID,
          CONSTRAINT "FK_supplier_sites_supplier"
            FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE,
          CONSTRAINT "FK_supplier_sites_site"
            FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE,
          CONSTRAINT "UQ_supplier_sites_supplier_site"
            UNIQUE ("supplierId", "siteId")
        );
        CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant"
          ON "supplier_sites" ("tenantId");
        CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant_supplier"
          ON "supplier_sites" ("tenantId", "supplierId");
        CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant_site"
          ON "supplier_sites" ("tenantId", "siteId");
      `);
      this.logger.log('Created supplier_sites table');
    } else {
      this.logger.log('supplier_sites already exists, skipping');
    }

    // -----------------------------------------------------------------
    // 2. site_contacts
    // -----------------------------------------------------------------
    const hasSiteContacts = await this.tableExists(queryRunner, 'site_contacts');
    if (!hasSiteContacts) {
      // CREATE TABLE + indexes ship in ONE query chunk so the
      // migration-sql-lint R3 grandfather kicks in (the table is
      // empty at index-creation time, no ACCESS EXCLUSIVE concern).
      // The partial unique on (siteId) WHERE isPrimary=true enforces
      // "at most one primary contact per site" while allowing
      // arbitrarily many non-primary contacts; a regular UNIQUE on
      // (siteId, isPrimary) would forbid two non-primary rows.
      await queryRunner.query(`
        CREATE TABLE "site_contacts" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenantId" UUID NOT NULL,
          "siteId" UUID NOT NULL,
          "name" VARCHAR(100) NOT NULL,
          "role" VARCHAR(100),
          "email" VARCHAR(150),
          "phone" VARCHAR(50),
          "isPrimary" BOOLEAN NOT NULL DEFAULT false,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "createdBy" UUID,
          CONSTRAINT "FK_site_contacts_site"
            FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IDX_site_contacts_tenant"
          ON "site_contacts" ("tenantId");
        CREATE INDEX IF NOT EXISTS "IDX_site_contacts_tenant_site"
          ON "site_contacts" ("tenantId", "siteId");
        CREATE INDEX IF NOT EXISTS "IDX_site_contacts_site_primary"
          ON "site_contacts" ("siteId", "isPrimary");
        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_site_contacts_one_primary_per_site"
          ON "site_contacts" ("siteId")
          WHERE "isPrimary" = true;
      `);
      this.logger.log('Created site_contacts table');
    } else {
      this.logger.log('site_contacts already exists, skipping');
    }

    this.logger.log('WireSupplierSitesAndSiteContacts migration completed');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');
    // Drop in reverse dependency order; both tables FK into
    // suppliers/sites which we leave intact.
    await queryRunner.query('DROP TABLE IF EXISTS "site_contacts"');
    await queryRunner.query('DROP TABLE IF EXISTS "supplier_sites"');
    this.logger.log('WireSupplierSitesAndSiteContacts rollback completed');
  }

  private async tableExists(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = $1
            AND table_schema = current_schema()
        ) AS exists
      `,
      [tableName],
    );
    return result[0]?.exists === true;
  }
}
