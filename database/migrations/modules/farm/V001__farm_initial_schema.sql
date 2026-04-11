-- V001: Farm module initial schema
-- Creates the farm schema and foundational tables: sites, departments, species.
-- Entity sources:
--   apps/farm-service/src/site/entities/site.entity.ts
--   apps/farm-service/src/department/entities/department.entity.ts
--   apps/farm-service/src/species/entities/species.entity.ts

CREATE SCHEMA IF NOT EXISTS farm;

-- ============================================================================
-- Sites - Physical facility locations
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  site_type VARCHAR(50) NOT NULL DEFAULT 'land_based',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  address TEXT,
  city VARCHAR(100),
  country VARCHAR(100),
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  altitude DECIMAL(8, 2),
  timezone VARCHAR(50),
  total_area_m2 DECIMAL(12, 2),
  water_source VARCHAR(100),
  license_number VARCHAR(100),
  license_expiry TIMESTAMPTZ,
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_sites_tenant" ON farm.sites (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_status" ON farm.sites (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sites_tenant_code"
  ON farm.sites (tenant_id, code) WHERE code IS NOT NULL;

-- ============================================================================
-- Departments - Organizational units within sites
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES farm.sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  department_type VARCHAR(50) NOT NULL DEFAULT 'production',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  manager_id UUID,
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_departments_tenant" ON farm.departments (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_departments_site" ON farm.departments (site_id);
CREATE INDEX IF NOT EXISTS "IDX_departments_tenant_status"
  ON farm.departments (tenant_id, status);

-- ============================================================================
-- Species - Master species library
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.species (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  common_name VARCHAR(255) NOT NULL,
  scientific_name VARCHAR(255),
  category VARCHAR(50) NOT NULL DEFAULT 'fish',
  water_type VARCHAR(50) NOT NULL DEFAULT 'freshwater',
  description TEXT,
  optimal_temp_min DECIMAL(5, 2),
  optimal_temp_max DECIMAL(5, 2),
  optimal_ph_min DECIMAL(4, 2),
  optimal_ph_max DECIMAL(4, 2),
  optimal_do_min DECIMAL(5, 2),
  optimal_salinity_min DECIMAL(5, 2),
  optimal_salinity_max DECIMAL(5, 2),
  growth_rate_data JSONB,
  metadata JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_species_tenant" ON farm.species (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_species_tenant_category"
  ON farm.species (tenant_id, category);
