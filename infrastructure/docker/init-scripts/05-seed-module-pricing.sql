-- ============================================================================
-- Seed Default Module Pricing Data
--
-- Inserts default pricing for 3 core modules: Farm, HR, Sensor
-- Looks up module IDs from auth.modules dynamically
-- Safe to run multiple times (checks for existing data)
-- ============================================================================

DO $$
DECLARE
    v_farm_module_id UUID;
    v_hr_module_id UUID;
    v_sensor_module_id UUID;
BEGIN
    -- INIT-FIX: skip when auth.modules / admin.module_pricing don't exist yet.
    -- These tables are created by auth-service / admin-api-service TypeORM migrations
    -- on app startup, AFTER init scripts run. Without this guard, ON_ERROR_STOP=1
    -- aborts postgres init on a fresh volume.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name = 'modules'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'module_pricing'
    ) THEN
        RAISE NOTICE 'auth.modules or admin.module_pricing not yet created — skipping module pricing seed. Re-run after services have migrated.';
        RETURN;
    END IF;

    -- Look up module IDs from auth.modules
    SELECT id INTO v_farm_module_id FROM auth.modules WHERE code = 'farm' LIMIT 1;
    SELECT id INTO v_hr_module_id FROM auth.modules WHERE code = 'hr' LIMIT 1;
    SELECT id INTO v_sensor_module_id FROM auth.modules WHERE code = 'sensor' LIMIT 1;

    -- ========================================================================
    -- Farm Module Pricing
    -- ========================================================================
    IF v_farm_module_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM admin.module_pricing WHERE "moduleCode" = 'farm' AND "isActive" = true
    ) THEN
        INSERT INTO admin.module_pricing (
            id, "moduleId", "moduleCode", "pricingMetrics", "tierMultipliers",
            currency, "effectiveFrom", "isActive", notes, version,
            "createdAt", "updatedAt"
        ) VALUES (
            gen_random_uuid(),
            v_farm_module_id,
            'farm',
            '[
                {"type": "base_price", "price": 50, "currency": "USD", "description": "Base monthly fee for Farm Management module"},
                {"type": "per_user", "price": 10, "currency": "USD", "description": "Per active user", "minQuantity": 1, "includedQuantity": 2},
                {"type": "per_farm", "price": 25, "currency": "USD", "description": "Per farm/site", "minQuantity": 1, "includedQuantity": 1},
                {"type": "per_pond", "price": 5, "currency": "USD", "description": "Per pond/tank", "includedQuantity": 10},
                {"type": "per_report", "price": 0.5, "currency": "USD", "description": "Per generated analytics report", "includedQuantity": 50}
            ]'::jsonb,
            '{"starter": 1.0, "professional": 0.9, "enterprise": 0.7, "custom": 0.7}'::jsonb,
            'USD',
            NOW(),
            true,
            'Default pricing from system seed',
            1,
            NOW(),
            NOW()
        );
        RAISE NOTICE 'Seeded pricing for farm module';
    ELSE
        IF v_farm_module_id IS NULL THEN
            RAISE NOTICE 'Farm module not found in auth.modules - skipping';
        ELSE
            RAISE NOTICE 'Farm module pricing already exists - skipping';
        END IF;
    END IF;

    -- ========================================================================
    -- HR Module Pricing
    -- ========================================================================
    IF v_hr_module_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM admin.module_pricing WHERE "moduleCode" = 'hr' AND "isActive" = true
    ) THEN
        INSERT INTO admin.module_pricing (
            id, "moduleId", "moduleCode", "pricingMetrics", "tierMultipliers",
            currency, "effectiveFrom", "isActive", notes, version,
            "createdAt", "updatedAt"
        ) VALUES (
            gen_random_uuid(),
            v_hr_module_id,
            'hr',
            '[
                {"type": "base_price", "price": 40, "currency": "USD", "description": "Base monthly fee for HR Management"},
                {"type": "per_user", "price": 8, "currency": "USD", "description": "Per employee managed", "includedQuantity": 10},
                {"type": "per_report", "price": 0.25, "currency": "USD", "description": "Per HR analytics report", "includedQuantity": 30}
            ]'::jsonb,
            '{"starter": 1.0, "professional": 0.9, "enterprise": 0.7, "custom": 0.7}'::jsonb,
            'USD',
            NOW(),
            true,
            'Default pricing from system seed',
            1,
            NOW(),
            NOW()
        );
        RAISE NOTICE 'Seeded pricing for hr module';
    ELSE
        IF v_hr_module_id IS NULL THEN
            RAISE NOTICE 'HR module not found in auth.modules - skipping';
        ELSE
            RAISE NOTICE 'HR module pricing already exists - skipping';
        END IF;
    END IF;

    -- ========================================================================
    -- Sensor Module Pricing
    -- ========================================================================
    IF v_sensor_module_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM admin.module_pricing WHERE "moduleCode" = 'sensor' AND "isActive" = true
    ) THEN
        INSERT INTO admin.module_pricing (
            id, "moduleId", "moduleCode", "pricingMetrics", "tierMultipliers",
            currency, "effectiveFrom", "isActive", notes, version,
            "createdAt", "updatedAt"
        ) VALUES (
            gen_random_uuid(),
            v_sensor_module_id,
            'sensor',
            '[
                {"type": "base_price", "price": 75, "currency": "USD", "description": "Base monthly fee for Sensor Monitoring module"},
                {"type": "per_user", "price": 10, "currency": "USD", "description": "Per active user", "minQuantity": 1, "includedQuantity": 2},
                {"type": "per_sensor", "price": 2, "currency": "USD", "description": "Per connected sensor", "includedQuantity": 10},
                {"type": "per_device", "price": 5, "currency": "USD", "description": "Per IoT gateway device", "includedQuantity": 2},
                {"type": "per_gb_storage", "price": 0.5, "currency": "USD", "description": "Per GB of sensor data storage (TimescaleDB)", "includedQuantity": 10},
                {"type": "per_alert", "price": 0.02, "currency": "USD", "description": "Per alert triggered", "includedQuantity": 1000},
                {"type": "per_report", "price": 0.5, "currency": "USD", "description": "Per sensor analytics report", "includedQuantity": 30}
            ]'::jsonb,
            '{"starter": 1.0, "professional": 0.9, "enterprise": 0.7, "custom": 0.7}'::jsonb,
            'USD',
            NOW(),
            true,
            'Default pricing from system seed',
            1,
            NOW(),
            NOW()
        );
        RAISE NOTICE 'Seeded pricing for sensor module';
    ELSE
        IF v_sensor_module_id IS NULL THEN
            RAISE NOTICE 'Sensor module not found in auth.modules - skipping';
        ELSE
            RAISE NOTICE 'Sensor module pricing already exists - skipping';
        END IF;
    END IF;
END
$$;
