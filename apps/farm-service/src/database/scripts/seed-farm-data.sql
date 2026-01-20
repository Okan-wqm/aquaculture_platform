-- =============================================================================
-- Farm Module - Seed Data Script
-- Bu script farm modulune sahip tenant'lar icin gerekli verileri olusturur
-- TypeORM tablolari olusturduktan sonra calistirilmalidir
-- =============================================================================

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
    -- STEP 1: EquipmentTypes olustur (global - tum tenant'lar icin)
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
                "createdAt", "updatedAt"
            ) VALUES (
                default_site_id, tenant_record.id,
                'Ana Tesis', 'SITE-001',
                'Varsayilan ana tesis',
                'Europe/Istanbul', 'active', true,
                NOW(), NOW()
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
                "createdAt", "updatedAt"
            ) VALUES (
                default_department_id, tenant_record.id, default_site_id,
                'Buyutme', 'DEPT-001',
                'Ana buyutme departmani',
                'grow_out', 'active', true,
                NOW(), NOW()
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
                "createdAt", "updatedAt"
            ) VALUES (
                default_system_id, tenant_record.id, default_site_id,
                'RAS Sistemi 1', 'SYS-001',
                'Recirculating Aquaculture System',
                'ras', 'active', true,
                NOW(), NOW()
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
                "createdAt", "updatedAt"
            ) VALUES (
                default_subsystem_id, tenant_record.id, default_system_id,
                'Buyutme Unitesi 1', 'SUBSYS-001',
                'Ana buyutme unitesi',
                'grow_out', 'active', true,
                NOW(), NOW()
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
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount"
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
                true, NOW(), NOW(), 'TRY', 0
            );

            -- Tank A2
            INSERT INTO equipment (
                id, "tenantId", "departmentId", "subSystemId", "equipmentTypeId",
                name, code, description, status, "isTank", volume,
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount"
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
                true, NOW(), NOW(), 'TRY', 0
            );

            -- Tank B1
            INSERT INTO equipment (
                id, "tenantId", "departmentId", "subSystemId", "equipmentTypeId",
                name, code, description, status, "isTank", volume,
                specifications, "isActive", "createdAt", "updatedAt", currency, "subEquipmentCount"
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
                true, NOW(), NOW(), 'TRY', 0
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

    END LOOP;

    RAISE NOTICE 'Farm Module Seed Data completed!';

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error: %', SQLERRM;
    -- Hatayi goster ama devam et
END $$;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Seed script completed.';
    RAISE NOTICE '========================================';
END $$;
