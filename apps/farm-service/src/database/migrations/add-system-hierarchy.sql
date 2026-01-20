-- Migration: Add System Hierarchy Support
-- Run this SQL directly on the database if TypeORM migrations are not set up
--
-- This migration adds:
-- 1. parent_system_id to systems table (self-referencing for nested systems)
-- 2. system_id to equipment table (link equipment to systems)
-- 3. parent_equipment_id to equipment table (self-referencing for nested equipment)

-- Set search path to farm schema
SET search_path TO farm, public;

-- ============================================================================
-- 1. Add parent_system_id to systems table
-- ============================================================================

-- Add column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'farm'
        AND table_name = 'systems'
        AND column_name = 'parent_system_id'
    ) THEN
        ALTER TABLE farm.systems
        ADD COLUMN parent_system_id UUID;

        -- Add foreign key
        ALTER TABLE farm.systems
        ADD CONSTRAINT "FK_systems_parent_system"
        FOREIGN KEY (parent_system_id)
        REFERENCES farm.systems(id)
        ON DELETE SET NULL;

        -- Add index
        CREATE INDEX "IDX_systems_parent_system_id"
        ON farm.systems(parent_system_id)
        WHERE parent_system_id IS NOT NULL;

        RAISE NOTICE 'Added parent_system_id to systems table';
    ELSE
        RAISE NOTICE 'parent_system_id already exists in systems table';
    END IF;
END $$;

-- ============================================================================
-- 2. Add system_id to equipment table
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'farm'
        AND table_name = 'equipment'
        AND column_name = 'system_id'
    ) THEN
        ALTER TABLE farm.equipment
        ADD COLUMN system_id UUID;

        -- Add foreign key
        ALTER TABLE farm.equipment
        ADD CONSTRAINT "FK_equipment_system"
        FOREIGN KEY (system_id)
        REFERENCES farm.systems(id)
        ON DELETE SET NULL;

        -- Add index
        CREATE INDEX "IDX_equipment_system_id"
        ON farm.equipment(system_id)
        WHERE system_id IS NOT NULL;

        RAISE NOTICE 'Added system_id to equipment table';
    ELSE
        RAISE NOTICE 'system_id already exists in equipment table';
    END IF;
END $$;

-- ============================================================================
-- 3. Add parent_equipment_id to equipment table
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'farm'
        AND table_name = 'equipment'
        AND column_name = 'parent_equipment_id'
    ) THEN
        ALTER TABLE farm.equipment
        ADD COLUMN parent_equipment_id UUID;

        -- Add foreign key
        ALTER TABLE farm.equipment
        ADD CONSTRAINT "FK_equipment_parent_equipment"
        FOREIGN KEY (parent_equipment_id)
        REFERENCES farm.equipment(id)
        ON DELETE SET NULL;

        -- Add index
        CREATE INDEX "IDX_equipment_parent_equipment_id"
        ON farm.equipment(parent_equipment_id)
        WHERE parent_equipment_id IS NOT NULL;

        RAISE NOTICE 'Added parent_equipment_id to equipment table';
    ELSE
        RAISE NOTICE 'parent_equipment_id already exists in equipment table';
    END IF;
END $$;

-- ============================================================================
-- Verification
-- ============================================================================

-- Verify columns were added
SELECT
    'systems' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'farm'
AND table_name = 'systems'
AND column_name = 'parent_system_id'

UNION ALL

SELECT
    'equipment' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'farm'
AND table_name = 'equipment'
AND column_name IN ('system_id', 'parent_equipment_id')
ORDER BY table_name, column_name;
