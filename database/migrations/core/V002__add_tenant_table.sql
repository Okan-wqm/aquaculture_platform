-- V002: Create tenants table in auth schema
-- Source-of-truth for tenant (company/organization) records.
-- Entity: apps/auth-service/src/modules/tenant/entities/tenant.entity.ts

CREATE TABLE IF NOT EXISTS auth.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT,
  logo_url VARCHAR(500),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  address TEXT,
  tax_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  plan VARCHAR(20) NOT NULL DEFAULT 'starter',
  max_users INT NOT NULL DEFAULT 5,
  trial_ends_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  custom_domain VARCHAR(255),
  settings JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "UQ_tenants_slug" UNIQUE (slug)
);

-- ── Indexes ──
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenants_slug" ON auth.tenants (slug);
CREATE INDEX IF NOT EXISTS "IDX_tenants_status" ON auth.tenants (status);
