-- =============================================================================
-- Hydroponics Module - Initial Schema
-- Creates the hydroponics schema and initial configuration table
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS hydroponics;

-- Configuration table for hydroponics module
CREATE TABLE hydroponics.hydroponics_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    config_name VARCHAR(255) NOT NULL DEFAULT 'Default',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_hydroponics_config_tenant_id ON hydroponics.hydroponics_config(tenant_id);
