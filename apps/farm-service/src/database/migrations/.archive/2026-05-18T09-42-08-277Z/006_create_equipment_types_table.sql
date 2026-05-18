-- Migration: 006_create_equipment_types_table
-- Description: Create equipment_types table for storing equipment type definitions
-- Date: 2024-12-15

-- Create enum type for equipment categories
DO $$ BEGIN
    CREATE TYPE equipment_category AS ENUM (
        'tank',
        'pump',
        'aeration',
        'filtration',
        'heating_cooling',
        'feeding',
        'monitoring',
        'water_treatment',
        'harvesting',
        'transport',
        'electrical',
        'plumbing',
        'safety',
        'other'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create equipment_types table
CREATE TABLE IF NOT EXISTS farm.equipment_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    category equipment_category NOT NULL DEFAULT 'other',
    icon VARCHAR(50),
    specification_schema JSONB NOT NULL DEFAULT '{"fields": []}',
    allowed_sub_equipment_types TEXT[],
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_system BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_equipment_types_code ON farm.equipment_types(code);
CREATE INDEX IF NOT EXISTS idx_equipment_types_category ON farm.equipment_types(category);
CREATE INDEX IF NOT EXISTS idx_equipment_types_is_active ON farm.equipment_types(is_active);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION farm.update_equipment_types_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_equipment_types_updated_at ON farm.equipment_types;
CREATE TRIGGER trigger_equipment_types_updated_at
    BEFORE UPDATE ON farm.equipment_types
    FOR EACH ROW
    EXECUTE FUNCTION farm.update_equipment_types_updated_at();
