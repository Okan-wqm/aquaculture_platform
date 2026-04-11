-- V004: Add feeding-related tables
-- Entity sources:
--   apps/farm-service/src/feed/entities/feed-type.entity.ts
--   apps/farm-service/src/feed/entities/feeding-protocol.entity.ts
--   apps/farm-service/src/feeding/entities/feeding-program.entity.ts
--   apps/farm-service/src/feeding/entities/daily-feeding-execution.entity.ts

-- ============================================================================
-- Feed types - Master feed product catalog
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.feed_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(255),
  manufacturer VARCHAR(255),
  pellet_size_mm DECIMAL(5, 2),
  protein_pct DECIMAL(5, 2),
  fat_pct DECIMAL(5, 2),
  fiber_pct DECIMAL(5, 2),
  energy_kj_per_kg DECIMAL(10, 2),
  description TEXT,
  nutritional_data JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_feed_types_tenant" ON farm.feed_types (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_feed_types_tenant_active"
  ON farm.feed_types (tenant_id, is_active);

-- ============================================================================
-- Feeding protocols - Rules for feeding schedules per species/stage
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.feeding_protocols (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  species_id UUID REFERENCES farm.species(id) ON DELETE SET NULL,
  feed_type_id UUID REFERENCES farm.feed_types(id) ON DELETE SET NULL,
  life_stage VARCHAR(50),
  feeding_rate_pct DECIMAL(5, 3),
  meals_per_day INT NOT NULL DEFAULT 2,
  description TEXT,
  schedule JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant"
  ON farm.feeding_protocols (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_species"
  ON farm.feeding_protocols (species_id);

-- ============================================================================
-- Daily feeding executions - Actual feeding events
-- ============================================================================
CREATE TABLE IF NOT EXISTS farm.daily_feeding_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  tank_id UUID NOT NULL,
  feed_type_id UUID REFERENCES farm.feed_types(id) ON DELETE SET NULL,
  feeding_date DATE NOT NULL,
  amount_kg DECIMAL(8, 3) NOT NULL,
  meals_count INT NOT NULL DEFAULT 1,
  notes TEXT,
  executed_by UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_tenant_date"
  ON farm.daily_feeding_executions (tenant_id, feeding_date);
CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_tank"
  ON farm.daily_feeding_executions (tank_id);
