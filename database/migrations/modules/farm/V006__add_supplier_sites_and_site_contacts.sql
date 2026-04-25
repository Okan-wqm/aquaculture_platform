-- V006: Add supplier_sites + site_contacts tables (Scope A Phase 4.4.1)
--
-- Closes FARM-ORPHAN-001 (SupplierSite never migrated) and
-- FARM-ORPHAN-002 (SiteContact never migrated). Mirrors the spec at
-- docs/illustrator/farm-modulu-sema-gorsel.md:1281,1344.
--
-- The TypeORM migration (1788100000000-WireSupplierSitesAndSiteContacts.ts)
-- runs the same DDL per tenant schema during the per-tenant phase
-- of the migration runner. THIS file is the source-of-truth template
-- the schema-snapshot-diff gate compares against.

CREATE TABLE IF NOT EXISTS supplier_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "isPreferred" BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdBy" UUID,
  CONSTRAINT fk_supplier_sites_supplier
    FOREIGN KEY ("supplierId") REFERENCES suppliers(id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_sites_site
    FOREIGN KEY ("siteId") REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT uq_supplier_sites_supplier_site
    UNIQUE ("supplierId", "siteId")
);

CREATE INDEX IF NOT EXISTS idx_supplier_sites_tenant
  ON supplier_sites ("tenantId");
CREATE INDEX IF NOT EXISTS idx_supplier_sites_tenant_supplier
  ON supplier_sites ("tenantId", "supplierId");
CREATE INDEX IF NOT EXISTS idx_supplier_sites_tenant_site
  ON supplier_sites ("tenantId", "siteId");

CREATE TABLE IF NOT EXISTS site_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(50),
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdBy" UUID,
  CONSTRAINT fk_site_contacts_site
    FOREIGN KEY ("siteId") REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_contacts_tenant
  ON site_contacts ("tenantId");
CREATE INDEX IF NOT EXISTS idx_site_contacts_tenant_site
  ON site_contacts ("tenantId", "siteId");
CREATE INDEX IF NOT EXISTS idx_site_contacts_site_primary
  ON site_contacts ("siteId", "isPrimary");

-- Partial unique: at most one primary contact per site. Regular
-- UNIQUE on (siteId, isPrimary) would forbid two non-primary rows
-- which is wrong — operators have multiple contacts; only one is
-- "the" primary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_contacts_one_primary_per_site
  ON site_contacts ("siteId")
  WHERE "isPrimary" = true;
