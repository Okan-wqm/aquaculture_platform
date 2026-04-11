-- V002: Add production tables (systems, tanks, batches)
-- Entity sources:
--   apps/farm-service/src/system/entities/system.entity.ts
--   apps/farm-service/src/tank/entities/tank.entity.ts
--   apps/farm-service/src/batch/entities/tank-batch.entity.ts

-- ============================================================================
-- Systems - Production systems within sites
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES farm.sites(id) ON DELETE CASCADE,
  department_id UUID REFERENCES farm.departments(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  system_type VARCHAR(50) NOT NULL DEFAULT 'ras',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  capacity_m3 DECIMAL(10, 2),
  max_biomass_kg DECIMAL(10, 2),
  species_id UUID REFERENCES farm.species(id) ON DELETE SET NULL,
  water_source VARCHAR(100),
  water_type VARCHAR(50),
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_systems_tenant" ON farm.systems (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_systems_site" ON farm.systems (site_id);
CREATE INDEX IF NOT EXISTS "IDX_systems_department" ON farm.systems (department_id);
CREATE INDEX IF NOT EXISTS "IDX_systems_tenant_status"
  ON farm.systems (tenant_id, status);

-- ============================================================================
-- Tanks - Physical grow-out / nursery tanks
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.tanks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID REFERENCES farm.sites(id) ON DELETE SET NULL,
  department_id UUID REFERENCES farm.departments(id) ON DELETE SET NULL,
  system_id UUID REFERENCES farm.systems(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  tank_type VARCHAR(50) NOT NULL DEFAULT 'circular',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  volume_m3 DECIMAL(10, 2),
  diameter_m DECIMAL(8, 2),
  length_m DECIMAL(8, 2),
  width_m DECIMAL(8, 2),
  depth_m DECIMAL(8, 2),
  max_biomass_kg DECIMAL(10, 2),
  current_biomass_kg DECIMAL(10, 2) DEFAULT 0,
  water_type VARCHAR(50),
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant" ON farm.tanks (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_tanks_system" ON farm.tanks (system_id);
CREATE INDEX IF NOT EXISTS "IDX_tanks_department" ON farm.tanks (department_id);
CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_status"
  ON farm.tanks (tenant_id, status);
