-- =============================================================================
-- Aquaculture Platform - Tank to Equipment Migration
-- Bu script mevcut tank verilerini equipment tablosuna migrate eder
-- ve yeni sistem/subsystem tablolarini olusturur
-- =============================================================================

-- Script tamamlandiktan sonra silinecek

DO $$
DECLARE
    tank_equipment_type_id UUID;
    tenant_record RECORD;
    site_record RECORD;
    tank_record RECORD;
    new_system_id UUID;
    new_equipment_id UUID;
BEGIN
    RAISE NOTICE 'Starting Tank to Equipment Migration...';

    -- =========================================================================
    -- STEP 1: equipment_types tablosuna 'Tank' tipini ekle (yoksa)
    -- =========================================================================
    SELECT id INTO tank_equipment_type_id FROM equipment_types WHERE code = 'TANK';

    IF tank_equipment_type_id IS NULL THEN
        tank_equipment_type_id := uuid_generate_v4();
        INSERT INTO equipment_types (
            id, name, code, description, category, icon,
            "specificationSchema", "isActive", "isSystem", "sortOrder",
            "createdAt", "updatedAt"
        ) VALUES (
            tank_equipment_type_id,
            'Tank',
            'TANK',
            'Yetistirme tanklari - dairesel, dikdortgen, raceway vb.',
            'tank',
            'tank',
            '{
                "fields": [
                    {"name": "tankType", "label": "Tank Tipi", "type": "select", "required": true, "options": [
                        {"value": "circular", "label": "Dairesel"},
                        {"value": "rectangular", "label": "Dikdortgen"},
                        {"value": "raceway", "label": "Raceway"},
                        {"value": "d_end", "label": "D-End"},
                        {"value": "oval", "label": "Oval"},
                        {"value": "square", "label": "Kare"}
                    ]},
                    {"name": "material", "label": "Malzeme", "type": "select", "required": true, "options": [
                        {"value": "fiberglass", "label": "Cam Elyaf"},
                        {"value": "concrete", "label": "Beton"},
                        {"value": "hdpe", "label": "HDPE"},
                        {"value": "steel", "label": "Celik"},
                        {"value": "stainless_steel", "label": "Paslanmaz Celik"}
                    ]},
                    {"name": "waterType", "label": "Su Tipi", "type": "select", "required": true, "options": [
                        {"value": "freshwater", "label": "Tatli Su"},
                        {"value": "saltwater", "label": "Tuzlu Su"},
                        {"value": "brackish", "label": "Aci Su"}
                    ]},
                    {"name": "diameter", "label": "Cap (m)", "type": "number", "unit": "m"},
                    {"name": "length", "label": "Uzunluk (m)", "type": "number", "unit": "m"},
                    {"name": "width", "label": "Genislik (m)", "type": "number", "unit": "m"},
                    {"name": "depth", "label": "Derinlik (m)", "type": "number", "required": true, "unit": "m"},
                    {"name": "maxBiomass", "label": "Maks Biomass (kg)", "type": "number", "required": true, "unit": "kg"},
                    {"name": "maxDensity", "label": "Maks Yogunluk (kg/m3)", "type": "number", "required": true, "unit": "kg/m3"}
                ],
                "groups": [
                    {"name": "physical", "label": "Fiziksel Ozellikler"},
                    {"name": "capacity", "label": "Kapasite"}
                ]
            }'::jsonb,
            true,
            true,
            1,
            NOW(),
            NOW()
        );
        RAISE NOTICE 'Created Tank equipment type with id: %', tank_equipment_type_id;
    ELSE
        RAISE NOTICE 'Tank equipment type already exists with id: %', tank_equipment_type_id;
    END IF;

    -- =========================================================================
    -- STEP 2: equipment tablosuna yeni kolonlari ekle (yoksa)
    -- =========================================================================

    -- isTank kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'isTank') THEN
        ALTER TABLE equipment ADD COLUMN "isTank" BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added isTank column to equipment table';
    END IF;

    -- volume kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'volume') THEN
        ALTER TABLE equipment ADD COLUMN volume DECIMAL(15,2);
        RAISE NOTICE 'Added volume column to equipment table';
    END IF;

    -- currentBiomass kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'currentBiomass') THEN
        ALTER TABLE equipment ADD COLUMN "currentBiomass" DECIMAL(15,2);
        RAISE NOTICE 'Added currentBiomass column to equipment table';
    END IF;

    -- currentCount kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'currentCount') THEN
        ALTER TABLE equipment ADD COLUMN "currentCount" INTEGER;
        RAISE NOTICE 'Added currentCount column to equipment table';
    END IF;

    -- subSystemId kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'subSystemId') THEN
        ALTER TABLE equipment ADD COLUMN "subSystemId" UUID;
        RAISE NOTICE 'Added subSystemId column to equipment table';
    END IF;

    -- isDeleted kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'isDeleted') THEN
        ALTER TABLE equipment ADD COLUMN "isDeleted" BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added isDeleted column to equipment table';
    END IF;

    -- deletedAt kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'deletedAt') THEN
        ALTER TABLE equipment ADD COLUMN "deletedAt" TIMESTAMPTZ;
        RAISE NOTICE 'Added deletedAt column to equipment table';
    END IF;

    -- deletedBy kolonu
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'equipment' AND column_name = 'deletedBy') THEN
        ALTER TABLE equipment ADD COLUMN "deletedBy" UUID;
        RAISE NOTICE 'Added deletedBy column to equipment table';
    END IF;

    -- =========================================================================
    -- STEP 3: systems tablosu yoksa olustur
    -- =========================================================================
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'systems') THEN
        CREATE TABLE systems (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            "tenantId" UUID NOT NULL,
            "siteId" UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            code VARCHAR(50) NOT NULL,
            description TEXT,
            type VARCHAR(50) DEFAULT 'other',
            status VARCHAR(50) DEFAULT 'active',
            specifications JSONB,
            "managerId" UUID,
            "managerName" VARCHAR(255),
            "subSystemCount" INTEGER DEFAULT 0,
            "equipmentCount" INTEGER DEFAULT 0,
            "isActive" BOOLEAN DEFAULT true,
            "isDeleted" BOOLEAN DEFAULT false,
            "deletedAt" TIMESTAMPTZ,
            "deletedBy" UUID,
            "createdAt" TIMESTAMPTZ DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
            "createdBy" UUID,
            "updatedBy" UUID,
            version INTEGER DEFAULT 1
        );

        CREATE UNIQUE INDEX idx_systems_tenant_site_code ON systems("tenantId", "siteId", code);
        CREATE UNIQUE INDEX idx_systems_tenant_site_name ON systems("tenantId", "siteId", name);
        CREATE INDEX idx_systems_tenant_type ON systems("tenantId", type);
        CREATE INDEX idx_systems_site ON systems("siteId");

        RAISE NOTICE 'Created systems table';
    END IF;

    -- =========================================================================
    -- STEP 4: sub_systems tablosu yoksa olustur
    -- =========================================================================
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sub_systems') THEN
        CREATE TABLE sub_systems (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            "tenantId" UUID NOT NULL,
            "systemId" UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            code VARCHAR(50) NOT NULL,
            description TEXT,
            type VARCHAR(50) DEFAULT 'other',
            status VARCHAR(50) DEFAULT 'active',
            specifications JSONB,
            "supervisorId" UUID,
            "supervisorName" VARCHAR(255),
            "equipmentCount" INTEGER DEFAULT 0,
            "tankCount" INTEGER DEFAULT 0,
            "isActive" BOOLEAN DEFAULT true,
            "isDeleted" BOOLEAN DEFAULT false,
            "deletedAt" TIMESTAMPTZ,
            "deletedBy" UUID,
            "createdAt" TIMESTAMPTZ DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
            "createdBy" UUID,
            "updatedBy" UUID,
            version INTEGER DEFAULT 1
        );

        CREATE UNIQUE INDEX idx_sub_systems_tenant_system_code ON sub_systems("tenantId", "systemId", code);
        CREATE UNIQUE INDEX idx_sub_systems_tenant_system_name ON sub_systems("tenantId", "systemId", name);
        CREATE INDEX idx_sub_systems_tenant_type ON sub_systems("tenantId", type);
        CREATE INDEX idx_sub_systems_system ON sub_systems("systemId");

        RAISE NOTICE 'Created sub_systems table';
    END IF;

    -- =========================================================================
    -- STEP 5: tank_batches tablosuna equipmentId kolonu ekle
    -- =========================================================================
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tank_batches') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_batches' AND column_name = 'equipmentId') THEN
            ALTER TABLE tank_batches ADD COLUMN "equipmentId" UUID;
            RAISE NOTICE 'Added equipmentId column to tank_batches table';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_batches' AND column_name = 'tankName') THEN
            ALTER TABLE tank_batches ADD COLUMN "tankName" VARCHAR(255);
            RAISE NOTICE 'Added tankName column to tank_batches table';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_batches' AND column_name = 'tankCode') THEN
            ALTER TABLE tank_batches ADD COLUMN "tankCode" VARCHAR(50);
            RAISE NOTICE 'Added tankCode column to tank_batches table';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_batches' AND column_name = 'primaryBatchNumber') THEN
            ALTER TABLE tank_batches ADD COLUMN "primaryBatchNumber" VARCHAR(50);
            RAISE NOTICE 'Added primaryBatchNumber column to tank_batches table';
        END IF;
    END IF;

    -- =========================================================================
    -- STEP 6: tank_allocations tablosuna equipmentId kolonu ekle
    -- =========================================================================
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tank_allocations') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'equipmentId') THEN
            ALTER TABLE tank_allocations ADD COLUMN "equipmentId" UUID;
            RAISE NOTICE 'Added equipmentId column to tank_allocations table';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'tankName') THEN
            ALTER TABLE tank_allocations ADD COLUMN "tankName" VARCHAR(255);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'tankCode') THEN
            ALTER TABLE tank_allocations ADD COLUMN "tankCode" VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'batchNumber') THEN
            ALTER TABLE tank_allocations ADD COLUMN "batchNumber" VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'sourceEquipmentId') THEN
            ALTER TABLE tank_allocations ADD COLUMN "sourceEquipmentId" UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_allocations' AND column_name = 'sourceTankName') THEN
            ALTER TABLE tank_allocations ADD COLUMN "sourceTankName" VARCHAR(255);
        END IF;
    END IF;

    -- =========================================================================
    -- STEP 7: tank_operations tablosuna equipmentId kolonu ekle
    -- =========================================================================
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tank_operations') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'equipmentId') THEN
            ALTER TABLE tank_operations ADD COLUMN "equipmentId" UUID;
            RAISE NOTICE 'Added equipmentId column to tank_operations table';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'tankName') THEN
            ALTER TABLE tank_operations ADD COLUMN "tankName" VARCHAR(255);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'tankCode') THEN
            ALTER TABLE tank_operations ADD COLUMN "tankCode" VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'batchNumber') THEN
            ALTER TABLE tank_operations ADD COLUMN "batchNumber" VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'destinationEquipmentId') THEN
            ALTER TABLE tank_operations ADD COLUMN "destinationEquipmentId" UUID;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tank_operations' AND column_name = 'destinationTankName') THEN
            ALTER TABLE tank_operations ADD COLUMN "destinationTankName" VARCHAR(255);
        END IF;
    END IF;

    -- =========================================================================
    -- STEP 8: Mevcut tanklari equipment tablosuna migrate et
    -- =========================================================================
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tanks') THEN
        RAISE NOTICE 'Starting tank migration to equipment...';

        FOR tank_record IN
            SELECT t.*, d.name as dept_name
            FROM tanks t
            LEFT JOIN departments d ON t."departmentId" = d.id
            WHERE NOT EXISTS (
                SELECT 1 FROM equipment e
                WHERE e."tenantId" = t."tenantId"
                AND e.code = t.code
                AND e."isTank" = true
            )
        LOOP
            new_equipment_id := uuid_generate_v4();

            INSERT INTO equipment (
                id, "tenantId", "departmentId", "equipmentTypeId",
                name, code, description, status,
                specifications, "isTank", volume,
                "currentBiomass", "currentCount",
                "isActive", "isDeleted",
                "createdAt", "updatedAt", "createdBy", "updatedBy", version,
                currency, "subEquipmentCount"
            ) VALUES (
                new_equipment_id,
                tank_record."tenantId",
                tank_record."departmentId",
                tank_equipment_type_id,
                tank_record.name,
                tank_record.code,
                tank_record.description,
                CASE tank_record.status
                    WHEN 'active' THEN 'active'
                    WHEN 'preparing' THEN 'preparing'
                    WHEN 'cleaning' THEN 'cleaning'
                    WHEN 'maintenance' THEN 'maintenance'
                    WHEN 'harvesting' THEN 'harvesting'
                    WHEN 'fallow' THEN 'fallow'
                    WHEN 'quarantine' THEN 'quarantine'
                    WHEN 'inactive' THEN 'out_of_service'
                    ELSE 'operational'
                END,
                jsonb_build_object(
                    'tankType', COALESCE(tank_record."tankType", 'circular'),
                    'material', COALESCE(tank_record.material, 'fiberglass'),
                    'waterType', COALESCE(tank_record."waterType", 'freshwater'),
                    'dimensions', jsonb_build_object(
                        'diameter', tank_record.diameter,
                        'length', tank_record.length,
                        'width', tank_record.width,
                        'depth', tank_record.depth,
                        'waterDepth', tank_record."waterDepth",
                        'freeboard', tank_record.freeboard
                    ),
                    'volume', tank_record.volume,
                    'waterVolume', tank_record."waterVolume",
                    'maxBiomass', tank_record."maxBiomass",
                    'maxDensity', tank_record."maxDensity",
                    'maxCount', tank_record."currentCount"
                ),
                true,
                tank_record.volume,
                tank_record."currentBiomass",
                tank_record."currentCount",
                tank_record."isActive",
                false,
                tank_record."createdAt",
                tank_record."updatedAt",
                tank_record."createdBy",
                tank_record."updatedBy",
                COALESCE(tank_record.version, 1),
                'TRY',
                0
            );

            -- tank_batches'i guncelle
            UPDATE tank_batches
            SET "equipmentId" = new_equipment_id,
                "tankName" = tank_record.name,
                "tankCode" = tank_record.code
            WHERE "tankId" = tank_record.id;

            -- tank_allocations'i guncelle
            UPDATE tank_allocations
            SET "equipmentId" = new_equipment_id,
                "tankName" = tank_record.name,
                "tankCode" = tank_record.code
            WHERE "tankId" = tank_record.id;

            -- source tank icin de guncelle
            UPDATE tank_allocations
            SET "sourceEquipmentId" = new_equipment_id,
                "sourceTankName" = tank_record.name
            WHERE "sourceTankId" = tank_record.id;

            -- tank_operations'i guncelle
            UPDATE tank_operations
            SET "equipmentId" = new_equipment_id,
                "tankName" = tank_record.name,
                "tankCode" = tank_record.code
            WHERE "tankId" = tank_record.id;

            -- destination tank icin de guncelle
            UPDATE tank_operations
            SET "destinationEquipmentId" = new_equipment_id,
                "destinationTankName" = tank_record.name
            WHERE "destinationTankId" = tank_record.id;

            RAISE NOTICE 'Migrated tank % (%) to equipment %', tank_record.name, tank_record.code, new_equipment_id;
        END LOOP;

        RAISE NOTICE 'Tank migration completed';
    END IF;

    -- =========================================================================
    -- STEP 9: Her site icin varsayilan bir sistem olustur
    -- =========================================================================
    RAISE NOTICE 'Creating default systems for sites...';

    FOR site_record IN
        SELECT s.* FROM sites s
        WHERE s."isActive" = true
        AND NOT EXISTS (
            SELECT 1 FROM systems sys
            WHERE sys."siteId" = s.id
        )
    LOOP
        new_system_id := uuid_generate_v4();

        INSERT INTO systems (
            id, "tenantId", "siteId", name, code, description,
            type, status, "isActive",
            "createdAt", "updatedAt"
        ) VALUES (
            new_system_id,
            site_record."tenantId",
            site_record.id,
            'Ana Sistem',
            'SYS-' || SUBSTRING(site_record.code FROM 1 FOR 10) || '-001',
            'Site icin varsayilan ana sistem',
            'ras',
            'active',
            true,
            NOW(),
            NOW()
        );

        RAISE NOTICE 'Created default system for site %', site_record.name;
    END LOOP;

    RAISE NOTICE 'Migration completed successfully!';

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error during migration: %', SQLERRM;
    RAISE;
END $$;

-- Index'leri olustur (hata vermezse)
CREATE INDEX IF NOT EXISTS idx_equipment_tenant_is_tank ON equipment("tenantId", "isTank");
CREATE INDEX IF NOT EXISTS idx_equipment_sub_system ON equipment("subSystemId");
CREATE INDEX IF NOT EXISTS idx_tank_batches_equipment ON tank_batches("equipmentId");
CREATE INDEX IF NOT EXISTS idx_tank_allocations_equipment ON tank_allocations("equipmentId");
CREATE INDEX IF NOT EXISTS idx_tank_operations_equipment ON tank_operations("equipmentId");

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Migration script completed.';
    RAISE NOTICE 'You can now delete this script file.';
    RAISE NOTICE '========================================';
END $$;
