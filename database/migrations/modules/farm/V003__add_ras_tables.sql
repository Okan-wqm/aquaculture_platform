-- V003: Add RAS (Recirculating Aquaculture System) related tables
-- Equipment and sub-systems for RAS installations.
-- Entity sources:
--   apps/farm-service/src/equipment/entities/equipment-system.entity.ts
--   apps/farm-service/src/system/entities/sub-system.entity.ts

-- ============================================================================
-- Sub-systems - Components of a production system
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.sub_systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  system_id UUID NOT NULL REFERENCES farm.systems(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  sub_system_type VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenant" ON farm.sub_systems (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_sub_systems_system" ON farm.sub_systems (system_id);

-- ============================================================================
-- Equipment - Physical equipment attached to systems/sub-systems
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.equipment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID REFERENCES farm.sites(id) ON DELETE SET NULL,
  system_id UUID REFERENCES farm.systems(id) ON DELETE SET NULL,
  sub_system_id UUID REFERENCES farm.sub_systems(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(100),
  equipment_type VARCHAR(100) NOT NULL,
  manufacturer VARCHAR(255),
  model VARCHAR(255),
  serial_number VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  description TEXT,
  installation_date TIMESTAMPTZ,
  last_maintenance_date TIMESTAMPTZ,
  next_maintenance_date TIMESTAMPTZ,
  specifications JSONB,
  settings JSONB DEFAULT '{}',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant" ON farm.equipment (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_equipment_system" ON farm.equipment (system_id);
CREATE INDEX IF NOT EXISTS "IDX_equipment_sub_system" ON farm.equipment (sub_system_id);
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_status"
  ON farm.equipment (tenant_id, status);
