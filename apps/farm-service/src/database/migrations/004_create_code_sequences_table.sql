-- Migration: 004_create_code_sequences_table
-- Description: Code sequences table for unique code generation
-- Date: 2024-11-29

-- =====================================================
-- CODE SEQUENCES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS code_sequences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  prefix VARCHAR(10) NOT NULL,
  year INT NOT NULL,
  last_sequence INT NOT NULL DEFAULT 0,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint for tenant + entity + year
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_sequences_unique
  ON code_sequences (tenant_id, entity_type, year);

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_code_sequences_tenant_entity
  ON code_sequences (tenant_id, entity_type);

-- =====================================================
-- TRIGGER FOR UPDATED_AT
-- =====================================================

DROP TRIGGER IF EXISTS trg_code_sequences_updated_at ON code_sequences;
CREATE TRIGGER trg_code_sequences_updated_at
  BEFORE UPDATE ON code_sequences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE code_sequences IS 'Tracks sequence numbers for entity code generation per tenant/year';
COMMENT ON COLUMN code_sequences.entity_type IS 'Entity name: Batch, Tank, Pond, Site, etc.';
COMMENT ON COLUMN code_sequences.prefix IS 'Code prefix: B, TNK, PND, SITE, etc.';
COMMENT ON COLUMN code_sequences.last_sequence IS 'Last used sequence number for this tenant/entity/year';
