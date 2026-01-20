-- =============================================================================
-- Farm Module - Tables and Seed Data
-- Bu script farm modulunun tablolarini olusturur ve seed data ekler
-- TypeORM sync calisana kadar kullanilacak geçici script
-- =============================================================================

-- UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE site_status AS ENUM ('active', 'maintenance', 'inactive', 'under_construction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE system_type AS ENUM ('ras', 'flow_through', 'pond', 'cage', 'raceway', 'hatchery', 'nursery', 'biofloc', 'aquaponics', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE system_status AS ENUM ('active', 'maintenance', 'inactive', 'commissioning');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE sub_system_type AS ENUM ('grow_out', 'nursery', 'hatchery', 'broodstock', 'quarantine', 'treatment', 'filtration', 'aeration', 'heating_cooling', 'feeding', 'harvesting', 'storage', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE sub_system_status AS ENUM ('active', 'maintenance', 'inactive', 'cleaning', 'fallow');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE equipment_category AS ENUM ('tank', 'pump', 'aeration', 'filtration', 'heating_cooling', 'feeding', 'monitoring', 'water_treatment', 'harvesting', 'transport', 'electrical', 'plumbing', 'safety', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE equipment_status AS ENUM ('operational', 'maintenance', 'repair', 'out_of_service', 'decommissioned', 'standby', 'active', 'preparing', 'cleaning', 'harvesting', 'fallow', 'quarantine');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE department_type AS ENUM ('production', 'grow_out', 'nursery', 'hatchery', 'broodstock', 'quarantine', 'processing', 'maintenance', 'administration', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE department_status AS ENUM ('active', 'maintenance', 'inactive', 'under_construction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- TABLES
-- ============================================================================

-- Sites table
CREATE TABLE IF NOT EXISTS sites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    location JSONB,
    address JSONB,
    country VARCHAR(100),
    region VARCHAR(100),
    timezone VARCHAR(50) DEFAULT 'UTC',
    status site_status DEFAULT 'active',
    settings JSONB,
    "totalArea" DECIMAL(15,2),
    "siteManager" VARCHAR(100),
    "contactEmail" VARCHAR(255),
    "contactPhone" VARCHAR(50),
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
    "createdBy" UUID,
    "updatedBy" UUID,
    version INTEGER DEFAULT 1,
    CONSTRAINT "UQ_sites_tenant_code" UNIQUE ("tenantId", code),
    CONSTRAINT "UQ_sites_tenant_name" UNIQUE ("tenantId", name)
);

CREATE INDEX IF NOT EXISTS "IDX_sites_tenantId" ON sites ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_status" ON sites ("tenantId", status);
CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_isActive" ON sites ("tenantId", "isActive");

-- Departments table
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "siteId" UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    type department_type DEFAULT 'other',
    status department_status DEFAULT 'active',
    settings JSONB,
    "managerId" UUID,
    "managerName" VARCHAR(255),
    "equipmentCount" INTEGER DEFAULT 0,
    "isActive" BOOLEAN DEFAULT true,
    "isDeleted" BOOLEAN DEFAULT false,
    "deletedAt" TIMESTAMPTZ,
    "deletedBy" UUID,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
    "createdBy" UUID,
    "updatedBy" UUID,
    version INTEGER DEFAULT 1,
    CONSTRAINT "UQ_departments_tenant_site_code" UNIQUE ("tenantId", "siteId", code),
    CONSTRAINT "UQ_departments_tenant_site_name" UNIQUE ("tenantId", "siteId", name)
);

CREATE INDEX IF NOT EXISTS "IDX_departments_tenantId" ON departments ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_departments_siteId" ON departments ("siteId");
CREATE INDEX IF NOT EXISTS "IDX_departments_tenant_type" ON departments ("tenantId", type);
CREATE INDEX IF NOT EXISTS "IDX_departments_tenant_status" ON departments ("tenantId", status);

-- Systems table
CREATE TABLE IF NOT EXISTS systems (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "siteId" UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    type system_type DEFAULT 'other',
    status system_status DEFAULT 'active',
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
    version INTEGER DEFAULT 1,
    CONSTRAINT "UQ_systems_tenant_site_code" UNIQUE ("tenantId", "siteId", code),
    CONSTRAINT "UQ_systems_tenant_site_name" UNIQUE ("tenantId", "siteId", name)
);

CREATE INDEX IF NOT EXISTS "IDX_systems_tenantId" ON systems ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_systems_siteId" ON systems ("siteId");
CREATE INDEX IF NOT EXISTS "IDX_systems_tenant_type" ON systems ("tenantId", type);
CREATE INDEX IF NOT EXISTS "IDX_systems_tenant_status" ON systems ("tenantId", status);

-- Sub Systems table
CREATE TABLE IF NOT EXISTS sub_systems (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "systemId" UUID NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    type sub_system_type DEFAULT 'other',
    status sub_system_status DEFAULT 'active',
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
    version INTEGER DEFAULT 1,
    CONSTRAINT "UQ_sub_systems_tenant_system_code" UNIQUE ("tenantId", "systemId", code),
    CONSTRAINT "UQ_sub_systems_tenant_system_name" UNIQUE ("tenantId", "systemId", name)
);

CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenantId" ON sub_systems ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_sub_systems_systemId" ON sub_systems ("systemId");
CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenant_type" ON sub_systems ("tenantId", type);
CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenant_status" ON sub_systems ("tenantId", status);

-- Equipment Types table (global)
CREATE TABLE IF NOT EXISTS equipment_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    category equipment_category DEFAULT 'other',
    icon VARCHAR(50),
    "specificationSchema" JSONB NOT NULL,
    "allowedSubEquipmentTypes" TEXT[],
    "isActive" BOOLEAN DEFAULT true,
    "isSystem" BOOLEAN DEFAULT false,
    "sortOrder" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IDX_equipment_types_code" ON equipment_types (code);
CREATE INDEX IF NOT EXISTS "IDX_equipment_types_category" ON equipment_types (category);
CREATE INDEX IF NOT EXISTS "IDX_equipment_types_isActive" ON equipment_types ("isActive");

-- Equipment table
CREATE TABLE IF NOT EXISTS equipment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "departmentId" UUID REFERENCES departments(id) ON DELETE CASCADE,
    "subSystemId" UUID REFERENCES sub_systems(id) ON DELETE CASCADE,
    "equipmentTypeId" UUID NOT NULL REFERENCES equipment_types(id),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    manufacturer VARCHAR(100),
    model VARCHAR(100),
    "serialNumber" VARCHAR(100),
    "purchaseDate" DATE,
    "installationDate" DATE,
    "warrantyEndDate" DATE,
    "purchasePrice" DECIMAL(15,2),
    currency VARCHAR(3) DEFAULT 'TRY',
    status equipment_status DEFAULT 'operational',
    location JSONB,
    specifications JSONB,
    "maintenanceSchedule" JSONB,
    "supplierId" UUID,
    "subEquipmentCount" INTEGER DEFAULT 0,
    "operatingHours" DECIMAL(10,2),
    notes TEXT,
    "isTank" BOOLEAN DEFAULT false,
    volume DECIMAL(15,2),
    "currentBiomass" DECIMAL(15,2),
    "currentCount" INTEGER,
    "isActive" BOOLEAN DEFAULT true,
    "isDeleted" BOOLEAN DEFAULT false,
    "deletedAt" TIMESTAMPTZ,
    "deletedBy" UUID,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
    "createdBy" UUID,
    "updatedBy" UUID,
    version INTEGER DEFAULT 1,
    CONSTRAINT "UQ_equipment_tenant_code" UNIQUE ("tenantId", code)
);

CREATE INDEX IF NOT EXISTS "IDX_equipment_tenantId" ON equipment ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_departmentId" ON equipment ("departmentId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_subSystemId" ON equipment ("subSystemId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_departmentId" ON equipment ("tenantId", "departmentId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_subSystemId" ON equipment ("tenantId", "subSystemId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_status" ON equipment ("tenantId", status);
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_equipmentTypeId" ON equipment ("tenantId", "equipmentTypeId");
CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_isTank" ON equipment ("tenantId", "isTank");
CREATE INDEX IF NOT EXISTS "IDX_equipment_serialNumber" ON equipment ("serialNumber");

-- Species table
CREATE TABLE IF NOT EXISTS species (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    "scientificName" VARCHAR(255),
    code VARCHAR(50) NOT NULL,
    category VARCHAR(50) DEFAULT 'finfish',
    description TEXT,
    "optimalTemperature" JSONB,
    "optimalPh" JSONB,
    "optimalSalinity" JSONB,
    "optimalOxygen" JSONB,
    "growthCurve" JSONB,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT "UQ_species_tenant_code" UNIQUE ("tenantId", code)
);

CREATE INDEX IF NOT EXISTS "IDX_species_tenantId" ON species ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_species_tenant_code" ON species ("tenantId", code);

-- ============================================================================
-- SEED DATA
-- ============================================================================

DO $$
DECLARE
    tenant_record RECORD;
    tank_equipment_type_id UUID;
    pump_equipment_type_id UUID;
    aerator_equipment_type_id UUID;
    filter_equipment_type_id UUID;
    default_site_id UUID;
    default_system_id UUID;
    default_subsystem_id UUID;
    default_department_id UUID;
BEGIN
    RAISE NOTICE 'Starting Farm Module Seed Data...';

    -- =========================================================================
    -- STEP 1: EquipmentTypes olustur (global)
    -- =========================================================================

    -- Tank tipi
    SELECT id INTO tank_equipment_type_id FROM equipment_types WHERE code = 'TANK';
    IF tank_equipment_type_id IS NULL THEN
        tank_equipment_type_id := uuid_generate_v4();
        INSERT INTO equipment_types (
            id, name, code, description, category, icon,
            "specificationSchema", "isActive", "isSystem", "sortOrder",
            "createdAt", "updatedAt"
        ) VALUES (
            tank_equipment_type_id, 'Tank', 'TANK',
            'Yetistirme tanklari - dairesel, dikdortgen, raceway vb.',
            'tank', 'tank',
            '{
                "fields": [
                    {"name": "tankType", "label": "Tank Tipi", "type": "select", "required": true,
                     "options": [{"value": "circular", "label": "Dairesel"},{"value": "rectangular", "label": "Dikdortgen"},{"value": "raceway", "label": "Raceway"}]},
                    {"name": "material", "label": "Malzeme", "type": "select", "required": true,
                     "options": [{"value": "fiberglass", "label": "Cam Elyaf"},{"value": "concrete", "label": "Beton"},{"value": "hdpe", "label": "HDPE"}]},
                    {"name": "waterType", "label": "Su Tipi", "type": "select", "required": true,
                     "options": [{"value": "freshwater", "label": "Tatli Su"},{"value": "saltwater", "label": "Tuzlu Su"}]},
                    {"name": "depth", "label": "Derinlik (m)", "type": "number", "required": true, "unit": "m"},
                    {"name": "maxBiomass", "label": "Maks Biomass (kg)", "type": "number", "required": true},
                    {"name": "maxDensity", "label": "Maks Yogunluk (kg/m3)", "type": "number", "required": true}
                ]
            }'::jsonb,
            true, true, 1, NOW(), NOW()
        );
        RAISE NOTICE 'Created Tank equipment type';
    END IF;

    -- Pump tipi
    SELECT id INTO pump_equipment_type_id FROM equipment_types WHERE code = 'PUMP';
    IF pump_equipment_type_id IS NULL THEN
        pump_equipment_type_id := uuid_generate_v4();
        INSERT INTO equipment_types (
            id, name, code, description, category, icon,
            "specificationSchema", "isActive", "isSystem", "sortOrder",
            "createdAt", "updatedAt"
        ) VALUES (
            pump_equipment_type_id, 'Pompa', 'PUMP',
            'Su pompalari',
            'pump', 'pump',
            '{"fields": [{"name": "flowRate", "label": "Debi (m3/h)", "type": "number"},{"name": "power", "label": "Guc (kW)", "type": "number"}]}'::jsonb,
            true, true, 2, NOW(), NOW()
        );
        RAISE NOTICE 'Created Pump equipment type';
    END IF;

    -- Aerator tipi
    SELECT id INTO aerator_equipment_type_id FROM equipment_types WHERE code = 'AERATOR';
    IF aerator_equipment_type_id IS NULL THEN
        aerator_equipment_type_id := uuid_generate_v4();
        INSERT INTO equipment_types (
            id, name, code, description, category, icon,
            "specificationSchema", "isActive", "isSystem", "sortOrder",
            "createdAt", "updatedAt"
        ) VALUES (
            aerator_equipment_type_id, 'Havalandirici', 'AERATOR',
            'Havalandirma ekipmanlari',
            'aeration', 'air',
            '{"fields": [{"name": "airFlowRate", "label": "Hava Debisi (L/min)", "type": "number"},{"name": "targetDO", "label": "Hedef DO (mg/L)", "type": "number"}]}'::jsonb,
            true, true, 3, NOW(), NOW()
        );
        RAISE NOTICE 'Created Aerator equipment type';
    END IF;

    -- Filter tipi
    SELECT id INTO filter_equipment_type_id FROM equipment_types WHERE code = 'FILTER';
    IF filter_equipment_type_id IS NULL THEN
        filter_equipment_type_id := uuid_generate_v4();
        INSERT INTO equipment_types (
            id, name, code, description, category, icon,
            "specificationSchema", "isActive", "isSystem", "sortOrder",
            "createdAt", "updatedAt"
        ) VALUES (
            filter_equipment_type_id, 'Filtre', 'FILTER',
            'Filtrasyon ekipmanlari',
            'filtration', 'filter',
            '{"fields": [{"name": "filterType", "label": "Filtre Tipi", "type": "select", "options": [{"value": "mechanical", "label": "Mekanik"},{"value": "biological", "label": "Biyolojik"},{"value": "uv", "label": "UV"}]},{"name": "capacity", "label": "Kapasite (m3/h)", "type": "number"}]}'::jsonb,
            true, true, 4, NOW(), NOW()
        );
        RAISE NOTICE 'Created Filter equipment type';
    END IF;

    -- =========================================================================
    -- STEP 2: Farm modulune sahip her tenant icin seed data olustur
    -- =========================================================================

    FOR tenant_record IN
        SELECT t.id, t.name
        FROM tenants t
        JOIN tenant_modules tm ON t.id = tm."tenantId"
        JOIN modules m ON tm."moduleId" = m.id
        WHERE m.code = 'farm'
        AND t.status = 'active'
    LOOP
        RAISE NOTICE 'Processing tenant: % (%)', tenant_record.name, tenant_record.id;

        -- Site yoksa varsayilan olustur
        SELECT id INTO default_site_id FROM sites WHERE "tenantId" = tenant_record.id LIMIT 1;
        IF default_site_id IS NULL THEN
            default_site_id := uuid_generate_v4();
            INSERT INTO sites (
                id, "tenantId", name, code, description, timezone, status, "isActive",
                "createdAt", "updatedAt", version
            ) VALUES (
                default_site_id, tenant_record.id,
                'Ana Tesis', 'SITE-001',
                'Varsayilan ana tesis',
                'Europe/Istanbul', 'active', true,
                NOW(), NOW(), 1
            );
            RAISE NOTICE '  Created default site: Ana Tesis';
        ELSE
            RAISE NOTICE '  Using existing site: %', default_site_id;
        END IF;

        -- Department yoksa varsayilan olustur
        SELECT id INTO default_department_id FROM departments WHERE "tenantId" = tenant_record.id AND "siteId" = default_site_id LIMIT 1;
        IF default_department_id IS NULL THEN
            default_department_id := uuid_generate_v4();
            INSERT INTO departments (
                id, "tenantId", "siteId", name, code, description, type, status, "isActive",
                "createdAt", "updatedAt", version, "equipmentCount"
            ) VALUES (
                default_department_id, tenant_record.id, default_site_id,
                'Buyutme', 'DEPT-001',
                'Ana buyutme departmani',
                'grow_out', 'active', true,
                NOW(), NOW(), 1, 0
            );
            RAISE NOTICE '  Created default department: Buyutme';
        ELSE
            RAISE NOTICE '  Using existing department: %', default_department_id;
        END IF;

        -- System yoksa varsayilan olustur
        SELECT id INTO default_system_id FROM systems WHERE "tenantId" = tenant_record.id AND "siteId" = default_site_id LIMIT 1;
        IF default_system_id IS NULL THEN
            default_system_id := uuid_generate_v4();
            INSERT INTO systems (
                id, "tenantId", "siteId", name, code, description, type, status, "isActive",
                "createdAt", "updatedAt", version, "subSystemCount", "equipmentCount"
            ) VALUES (
                default_system_id, tenant_record.id, default_site_id,
                'RAS Sistemi 1', 'SYS-001',
                'Recirculating Aquaculture System',
                'ras', 'active', true,
                NOW(), NOW(), 1, 0, 0
            );
            RAISE NOTICE '  Created default system: RAS Sistemi 1';
        ELSE
            RAISE NOTICE '  Using existing system: %', default_system_id;
        END IF;

        -- SubSystem yoksa varsayilan olustur
        SELECT id INTO default_subsystem_id FROM sub_systems WHERE "tenantId" = tenant_record.id AND "systemId" = default_system_id LIMIT 1;
        IF default_subsystem_id IS NULL THEN
            default_subsystem_id := uuid_generate_v4();
            INSERT INTO sub_systems (
                id, "tenantId", "systemId", name, code, description, type, status, "isActive",
                "createdAt", "updatedAt", version, "equipmentCount", "tankCount"
            ) VALUES (
                default_subsystem_id, tenant_record.id, default_system_id,
                'Buyutme Unitesi 1', 'SUBSYS-001',
                'Ana buyutme unitesi',
                'grow_out', 'active', true,
                NOW(), NOW(), 1, 0, 0
            );
            RAISE NOTICE '  Created default sub-system: Buyutme Unitesi 1';
        ELSE
            RAISE NOTICE '  Using existing sub-system: %', default_subsystem_id;
        END IF;

        -- Ornek tanklar olustur (yoksa)
        IF NOT EXISTS (SELECT 1 FROM equipment WHERE "tenantId" = tenant_record.id AND "isTank" = true) THEN
            -- Tank A1
            INSERT INTO equipment (
                id, "tenantId", "departmentId", "subSystemId", "equipmentTypeId",
                name, code, description, status, "isTank", volume,
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount", version, "isDeleted"
            ) VALUES (
                uuid_generate_v4(), tenant_record.id, default_department_id, default_subsystem_id, tank_equipment_type_id,
                'Tank A1', 'TNK-A1', 'Dairesel buyutme tanki',
                'operational', true, 200,
                '{
                    "tankType": "circular",
                    "material": "fiberglass",
                    "waterType": "saltwater",
                    "dimensions": {"diameter": 8, "depth": 4, "waterDepth": 3.5},
                    "volume": 200,
                    "maxBiomass": 6000,
                    "maxDensity": 30
                }'::jsonb,
                true, NOW(), NOW(), 'TRY', 0, 1, false
            );

            -- Tank A2
            INSERT INTO equipment (
                id, "tenantId", "departmentId", "subSystemId", "equipmentTypeId",
                name, code, description, status, "isTank", volume,
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount", version, "isDeleted"
            ) VALUES (
                uuid_generate_v4(), tenant_record.id, default_department_id, default_subsystem_id, tank_equipment_type_id,
                'Tank A2', 'TNK-A2', 'Dairesel buyutme tanki',
                'operational', true, 200,
                '{
                    "tankType": "circular",
                    "material": "fiberglass",
                    "waterType": "saltwater",
                    "dimensions": {"diameter": 8, "depth": 4, "waterDepth": 3.5},
                    "volume": 200,
                    "maxBiomass": 6000,
                    "maxDensity": 30
                }'::jsonb,
                true, NOW(), NOW(), 'TRY', 0, 1, false
            );

            -- Tank B1
            INSERT INTO equipment (
                id, "tenantId", "departmentId", "subSystemId", "equipmentTypeId",
                name, code, description, status, "isTank", volume,
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount", version, "isDeleted"
            ) VALUES (
                uuid_generate_v4(), tenant_record.id, default_department_id, default_subsystem_id, tank_equipment_type_id,
                'Tank B1', 'TNK-B1', 'Dikdortgen buyutme tanki',
                'operational', true, 250,
                '{
                    "tankType": "rectangular",
                    "material": "concrete",
                    "waterType": "saltwater",
                    "dimensions": {"length": 10, "width": 5, "depth": 5, "waterDepth": 4.5},
                    "volume": 250,
                    "maxBiomass": 7500,
                    "maxDensity": 30
                }'::jsonb,
                true, NOW(), NOW(), 'TRY', 0, 1, false
            );

            RAISE NOTICE '  Created 3 sample tanks';
        ELSE
            RAISE NOTICE '  Tanks already exist, skipping...';
        END IF;

        -- Species yoksa varsayilan olustur
        IF NOT EXISTS (SELECT 1 FROM species WHERE "tenantId" = tenant_record.id) THEN
            INSERT INTO species (
                id, "tenantId", name, "scientificName", code, category, "isActive",
                "createdAt", "updatedAt"
            ) VALUES
            (uuid_generate_v4(), tenant_record.id, 'Atlantik Somon', 'Salmo salar', 'SALMON', 'finfish', true, NOW(), NOW()),
            (uuid_generate_v4(), tenant_record.id, 'Gokkusagi Alabaligi', 'Oncorhynchus mykiss', 'TROUT', 'finfish', true, NOW(), NOW()),
            (uuid_generate_v4(), tenant_record.id, 'Levrek', 'Dicentrarchus labrax', 'SEABASS', 'finfish', true, NOW(), NOW()),
            (uuid_generate_v4(), tenant_record.id, 'Cipura', 'Sparus aurata', 'SEABREAM', 'finfish', true, NOW(), NOW());
            RAISE NOTICE '  Created 4 species';
        ELSE
            RAISE NOTICE '  Species already exist, skipping...';
        END IF;

        -- Update denormalized counts
        UPDATE systems SET "subSystemCount" = 1 WHERE id = default_system_id;
        UPDATE sub_systems SET "tankCount" = 3, "equipmentCount" = 3 WHERE id = default_subsystem_id;
        UPDATE departments SET "equipmentCount" = 3 WHERE id = default_department_id;

    END LOOP;

    RAISE NOTICE 'Farm Module Seed Data completed!';

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error: %', SQLERRM;
END $$;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Farm tables and seed script completed.';
    RAISE NOTICE '========================================';
END $$;
