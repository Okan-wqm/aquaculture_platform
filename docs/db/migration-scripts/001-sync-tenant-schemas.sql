-- =============================================================================
-- Migration 001: Sync tenant schemas with MODULE_SCHEMAS registry
-- =============================================================================
-- Date:    2026-03-18
-- Purpose: After MODULE_SCHEMAS was updated (14 phantom tables removed,
--          11 new tables added), existing tenant schemas are out of sync.
--          This migration brings them in line with the current registry.
--
-- WHAT THIS DOES:
--   1. DROP 2 phantom tables (empty, never belonged to any module)
--   2. CREATE 8 missing tables (cloned from source schemas with LIKE)
--   3. CREATE enum types in each tenant schema for farm/hr tables
--
-- TABLES NOT HANDLED (source schemas don't have them yet):
--   - farm_workers        (farm)   -- entity not deployed yet
--   - lora_devices        (sensor) -- entity not deployed yet
--   - sensor_audit_logs   (sensor) -- entity not deployed yet (audit_logs exists but name mismatch)
--   - supplier_sites      (farm)   -- entity not deployed yet
--   - site_contacts       (farm)   -- entity not deployed yet
--   - sensor_metrics      (sensor) -- entity not deployed yet
--   - tenant_provisioning_keys (sensor) -- entity not deployed yet
--   - device_events       (sensor) -- entity not deployed yet
--   - departments_hr      (hr)     -- HANDLED BELOW (exists in hr schema)
--   - hydroponics_config  (hydroponics) -- entity not deployed yet
--   - alert_rules, alert_incidents, escalation_policies, alert_history,
--     alert_audit_log     (alert)  -- entities not deployed yet
--
--   These tables will be automatically created when their respective services
--   restart with DATABASE_SYNC=true, as the TenantConnectionBootstrap service
--   handles search_path routing. No manual migration needed for those.
--
-- IDEMPOTENT: Safe to run multiple times.
-- ROLLBACK:   Commented rollback statements at the bottom.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1: DROP phantom tables (verified empty across all 5 tenant schemas)
-- ---------------------------------------------------------------------------
-- These tables were created by old MODULE_SCHEMAS entries that have since been
-- removed. They belong to auth/admin schemas, not tenant schemas.

DO $$
DECLARE
    schema_rec RECORD;
    phantom_tables TEXT[] := ARRAY['user_consents', 'gdpr_data_requests'];
    tbl TEXT;
    row_count BIGINT;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        FOREACH tbl IN ARRAY phantom_tables
        LOOP
            -- Only drop if table exists
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = schema_rec.schema_name
                  AND table_name = tbl
            ) THEN
                -- Safety: verify table is empty before dropping
                EXECUTE format('SELECT count(*) FROM %I.%I', schema_rec.schema_name, tbl)
                    INTO row_count;

                IF row_count > 0 THEN
                    RAISE WARNING 'Table %.% has % rows -- SKIPPING DROP',
                        schema_rec.schema_name, tbl, row_count;
                ELSE
                    EXECUTE format('DROP TABLE %I.%I', schema_rec.schema_name, tbl);
                    RAISE NOTICE 'Dropped empty phantom table %.%',
                        schema_rec.schema_name, tbl;
                END IF;
            ELSE
                RAISE NOTICE 'Table %.% does not exist -- nothing to drop',
                    schema_rec.schema_name, tbl;
            END IF;
        END LOOP;
    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 2: CREATE enum types needed by new farm tables
-- ---------------------------------------------------------------------------
-- farm.tasks, farm.auto_rules, farm.recurring_templates use schema-qualified
-- enums (farm.tasks_category_enum, etc.). CREATE TABLE ... LIKE does not copy
-- enum type definitions, so we must create them in each tenant schema first.

DO $$
DECLARE
    schema_rec RECORD;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        -- tasks enums
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'tasks_category_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.tasks_category_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''FEEDING'', ''WATER_QUALITY'', ''HEALTH_CHECK'', ''EQUIPMENT_MAINTENANCE'', ''STOCK_MANAGEMENT'', ''CLEANING'', ''REGULATORY'', ''HARVEST'', ''ENVIRONMENTAL'', ''SAFETY'', ''GENERAL'''
            );
            RAISE NOTICE 'Created enum %.tasks_category_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'tasks_priority_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.tasks_priority_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''URGENT'', ''HIGH'', ''MEDIUM'', ''LOW'''
            );
            RAISE NOTICE 'Created enum %.tasks_priority_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'tasks_status_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.tasks_status_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''PENDING'', ''IN_PROGRESS'', ''COMPLETED'', ''OVERDUE'', ''CANCELLED'''
            );
            RAISE NOTICE 'Created enum %.tasks_status_enum', schema_rec.schema_name;
        END IF;

        -- auto_rules enums
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'auto_rules_trigger_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.auto_rules_trigger_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''STOCK_LOW'', ''EXPIRY_NEAR'', ''MAINTENANCE_DUE'', ''SCHEDULE'', ''LICENSE_EXPIRY'', ''WATER_PARAM_ALERT'''
            );
            RAISE NOTICE 'Created enum %.auto_rules_trigger_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'auto_rules_taskcategory_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.auto_rules_taskcategory_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''FEEDING'', ''WATER_QUALITY'', ''HEALTH_CHECK'', ''EQUIPMENT_MAINTENANCE'', ''STOCK_MANAGEMENT'', ''CLEANING'', ''REGULATORY'', ''HARVEST'', ''ENVIRONMENTAL'', ''SAFETY'', ''GENERAL'''
            );
            RAISE NOTICE 'Created enum %.auto_rules_taskcategory_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'auto_rules_taskpriority_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.auto_rules_taskpriority_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''URGENT'', ''HIGH'', ''MEDIUM'', ''LOW'''
            );
            RAISE NOTICE 'Created enum %.auto_rules_taskpriority_enum', schema_rec.schema_name;
        END IF;

        -- recurring_templates enums
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'recurring_templates_category_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.recurring_templates_category_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''FEEDING'', ''WATER_QUALITY'', ''HEALTH_CHECK'', ''EQUIPMENT_MAINTENANCE'', ''STOCK_MANAGEMENT'', ''CLEANING'', ''REGULATORY'', ''HARVEST'', ''ENVIRONMENTAL'', ''SAFETY'', ''GENERAL'''
            );
            RAISE NOTICE 'Created enum %.recurring_templates_category_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'recurring_templates_frequency_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.recurring_templates_frequency_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''HOURLY'', ''DAILY'', ''WEEKLY'', ''BIWEEKLY'', ''MONTHLY'', ''CUSTOM'''
            );
            RAISE NOTICE 'Created enum %.recurring_templates_frequency_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'recurring_templates_priority_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.recurring_templates_priority_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''URGENT'', ''HIGH'', ''MEDIUM'', ''LOW'''
            );
            RAISE NOTICE 'Created enum %.recurring_templates_priority_enum', schema_rec.schema_name;
        END IF;

    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 3: CREATE enum types needed by new HR tables
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    schema_rec RECORD;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        -- goals enums
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'goals_priority_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.goals_priority_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''LOW'', ''MEDIUM'', ''HIGH'', ''CRITICAL'''
            );
            RAISE NOTICE 'Created enum %.goals_priority_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'goals_status_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.goals_status_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''NOT_STARTED'', ''IN_PROGRESS'', ''COMPLETED'', ''CANCELLED'', ''DEFERRED'''
            );
            RAISE NOTICE 'Created enum %.goals_status_enum', schema_rec.schema_name;
        END IF;

        -- performance_reviews enums
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'performance_reviews_periodtype_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.performance_reviews_periodtype_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''ANNUAL'', ''SEMI_ANNUAL'', ''QUARTERLY'', ''PROBATION'', ''PROJECT'''
            );
            RAISE NOTICE 'Created enum %.performance_reviews_periodtype_enum', schema_rec.schema_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'performance_reviews_status_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.performance_reviews_status_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''DRAFT'', ''SELF_ASSESSMENT'', ''MANAGER_REVIEW'', ''CALIBRATION'', ''FINALIZED'', ''ACKNOWLEDGED'''
            );
            RAISE NOTICE 'Created enum %.performance_reviews_status_enum', schema_rec.schema_name;
        END IF;

        -- departments_hr enum
        IF NOT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE n.nspname = schema_rec.schema_name AND t.typname = 'departments_hr_type_enum'
        ) THEN
            EXECUTE format(
                'CREATE TYPE %I.departments_hr_type_enum AS ENUM (%s)',
                schema_rec.schema_name,
                '''operations'', ''maintenance'', ''feeding'', ''quality_control'', ''administration'', ''management'', ''logistics'', ''security'', ''hatchery'', ''grow_out'', ''processing'', ''laboratory'', ''general'''
            );
            RAISE NOTICE 'Created enum %.departments_hr_type_enum', schema_rec.schema_name;
        END IF;

    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 4: CREATE missing tables from farm source schema
-- ---------------------------------------------------------------------------
-- Tables: tasks, auto_rules, recurring_templates
-- Source: farm schema (verified to exist)
--
-- We cannot use CREATE TABLE ... LIKE because:
--   1. LIKE copies the column types literally (farm.tasks_status_enum),
--      but we need the tenant-schema-qualified versions.
--   2. LIKE does not copy enum type definitions.
-- Therefore, we create the tables explicitly with correct schema-local enums.

DO $$
DECLARE
    schema_rec RECORD;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        -- ===== tasks =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'tasks'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.tasks (
                    id              uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"      uuid NOT NULL,
                    title           varchar(255) NOT NULL,
                    description     text,
                    category        %1$I.tasks_category_enum NOT NULL,
                    priority        %1$I.tasks_priority_enum NOT NULL,
                    status          %1$I.tasks_status_enum NOT NULL DEFAULT ''PENDING'',
                    "assignedTo"    uuid NOT NULL,
                    "assignedToName" varchar(255) NOT NULL,
                    "createdBy"     uuid NOT NULL,
                    "dueDate"       date NOT NULL,
                    "siteId"        uuid,
                    location        varchar,
                    "estimatedMinutes" integer,
                    "checklistItems" jsonb NOT NULL DEFAULT ''[]'',
                    notes           jsonb NOT NULL DEFAULT ''[]'',
                    "isRecurring"   boolean NOT NULL DEFAULT false,
                    "recurringTemplateId" uuid,
                    "isAutoGenerated" boolean NOT NULL DEFAULT false,
                    "completedAt"   timestamptz,
                    "completedBy"   uuid,
                    "createdAt"     timestamptz NOT NULL DEFAULT now(),
                    "updatedAt"     timestamptz NOT NULL DEFAULT now(),
                    "deletedAt"     timestamptz,
                    "dueTime"       time without time zone,
                    tags            jsonb DEFAULT ''[]'',
                    CONSTRAINT tasks_pkey PRIMARY KEY (id)
                )', schema_rec.schema_name);

            -- Indexes (matching farm.tasks)
            EXECUTE format('CREATE INDEX idx_tasks_tenant_duedate ON %I.tasks ("tenantId", "dueDate")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_tasks_status_duedate ON %I.tasks (status, "dueDate")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_tasks_tenant_assigned_status ON %I.tasks ("tenantId", "assignedTo", status)', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_tasks_tenant_status_priority ON %I.tasks ("tenantId", status, priority)', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.tasks with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.tasks already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== auto_rules =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'auto_rules'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.auto_rules (
                    id              uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"      uuid NOT NULL,
                    name            varchar(255) NOT NULL,
                    description     text,
                    trigger         %1$I.auto_rules_trigger_enum NOT NULL,
                    "triggerCondition" text NOT NULL,
                    "taskTitle"     varchar(255) NOT NULL,
                    "taskDescription" text,
                    "taskCategory"  %1$I.auto_rules_taskcategory_enum NOT NULL,
                    "taskPriority"  %1$I.auto_rules_taskpriority_enum NOT NULL,
                    "assignTo"      uuid,
                    "isActive"      boolean NOT NULL DEFAULT true,
                    "lastTriggered" timestamptz,
                    "triggerCount"  integer NOT NULL DEFAULT 0,
                    "createdAt"     timestamptz NOT NULL DEFAULT now(),
                    "updatedAt"     timestamptz NOT NULL DEFAULT now(),
                    "deletedAt"     timestamptz,
                    CONSTRAINT auto_rules_pkey PRIMARY KEY (id)
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_auto_rules_tenant_active ON %I.auto_rules ("tenantId", "isActive")', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.auto_rules with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.auto_rules already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== recurring_templates =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'recurring_templates'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.recurring_templates (
                    id              uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"      uuid NOT NULL,
                    title           varchar(255) NOT NULL,
                    description     text,
                    category        %1$I.recurring_templates_category_enum NOT NULL,
                    priority        %1$I.recurring_templates_priority_enum NOT NULL,
                    frequency       %1$I.recurring_templates_frequency_enum NOT NULL,
                    "frequencyDetail" varchar,
                    "assignedTo"    uuid NOT NULL,
                    "assignedToName" varchar(255) NOT NULL,
                    location        varchar,
                    "estimatedMinutes" integer,
                    "checklistItems" jsonb NOT NULL DEFAULT ''[]'',
                    "isActive"      boolean NOT NULL DEFAULT true,
                    "lastGenerated" timestamptz,
                    "nextGeneration" timestamptz,
                    "createdAt"     timestamptz NOT NULL DEFAULT now(),
                    "updatedAt"     timestamptz NOT NULL DEFAULT now(),
                    "deletedAt"     timestamptz,
                    tags            jsonb DEFAULT ''[]'',
                    CONSTRAINT recurring_templates_pkey PRIMARY KEY (id)
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_recurring_active_next ON %I.recurring_templates ("isActive", "nextGeneration")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_recurring_tenant_active ON %I.recurring_templates ("tenantId", "isActive")', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.recurring_templates with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.recurring_templates already exists -- skipping', schema_rec.schema_name;
        END IF;

    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 5: CREATE missing tables from sensor source schema
-- ---------------------------------------------------------------------------
-- Tables: device_groups, device_group_members
-- Source: sensor schema (verified to exist)
-- Note: These tables use snake_case columns (sensor service convention),
--       no custom enum types needed.
--
-- NOT CREATED (source tables don't exist yet):
--   - lora_devices
--   - sensor_audit_logs (audit_logs exists but with different name)

DO $$
DECLARE
    schema_rec RECORD;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        -- ===== device_groups =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'device_groups'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.device_groups (
                    id              uuid NOT NULL DEFAULT gen_random_uuid(),
                    tenant_id       uuid NOT NULL,
                    name            varchar(100) NOT NULL,
                    description     text,
                    type            varchar(50) NOT NULL DEFAULT ''custom'',
                    parent_group_id uuid,
                    metadata        jsonb,
                    created_at      timestamptz NOT NULL DEFAULT now(),
                    updated_at      timestamptz NOT NULL DEFAULT now(),
                    CONSTRAINT device_groups_pkey PRIMARY KEY (id),
                    CONSTRAINT device_groups_parent_fkey FOREIGN KEY (parent_group_id)
                        REFERENCES %1$I.device_groups(id) ON DELETE SET NULL
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_device_groups_tenant ON %I.device_groups (tenant_id)', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.device_groups with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.device_groups already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== device_group_members =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'device_group_members'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.device_group_members (
                    id          uuid NOT NULL DEFAULT gen_random_uuid(),
                    group_id    uuid NOT NULL,
                    device_type varchar(50) NOT NULL,
                    device_id   uuid NOT NULL,
                    added_at    timestamptz NOT NULL DEFAULT now(),
                    CONSTRAINT device_group_members_pkey PRIMARY KEY (id),
                    CONSTRAINT device_group_members_unique UNIQUE (group_id, device_type, device_id),
                    CONSTRAINT device_group_members_group_fkey FOREIGN KEY (group_id)
                        REFERENCES %1$I.device_groups(id) ON DELETE CASCADE
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_dgm_device ON %I.device_group_members (device_type, device_id)', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_dgm_group ON %I.device_group_members (group_id)', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.device_group_members with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.device_group_members already exists -- skipping', schema_rec.schema_name;
        END IF;

    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 6: CREATE missing tables from HR source schema
-- ---------------------------------------------------------------------------
-- Tables: goals, performance_reviews, employee_kpis, departments_hr
-- Source: hr schema (verified to exist)
-- Note: HR tables use camelCase columns (TypeORM convention) and reference
--       hr.employees via foreign keys. In tenant schemas, employees table
--       already exists, so FKs should reference the local employees table.

DO $$
DECLARE
    schema_rec RECORD;
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        -- ===== departments_hr =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'departments_hr'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.departments_hr (
                    id                  uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"          varchar NOT NULL,
                    "siteId"            varchar,
                    "parentDepartmentId" varchar,
                    name                varchar(150) NOT NULL,
                    code                varchar(20) NOT NULL,
                    type                %1$I.departments_hr_type_enum NOT NULL DEFAULT ''general'',
                    description         text,
                    "managerId"         varchar,
                    "budgetCode"        varchar(50),
                    "costCenter"        varchar(50),
                    "isActive"          boolean NOT NULL DEFAULT true,
                    "sortOrder"         integer NOT NULL DEFAULT 0,
                    "createdAt"         timestamp NOT NULL DEFAULT now(),
                    "updatedAt"         timestamp NOT NULL DEFAULT now(),
                    "createdBy"         varchar,
                    "updatedBy"         varchar,
                    version             integer NOT NULL,
                    "isDeleted"         boolean NOT NULL DEFAULT false,
                    "deletedAt"         timestamp,
                    "deletedBy"         varchar,
                    CONSTRAINT departments_hr_pkey PRIMARY KEY (id)
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_dept_hr_tenant ON %I.departments_hr ("tenantId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_dept_hr_tenant_deleted ON %I.departments_hr ("tenantId", "isDeleted")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_dept_hr_tenant_site ON %I.departments_hr ("tenantId", "siteId")', schema_rec.schema_name);
            EXECUTE format('CREATE UNIQUE INDEX idx_dept_hr_tenant_code ON %I.departments_hr ("tenantId", code)', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.departments_hr with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.departments_hr already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== goals =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'goals'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.goals (
                    id              uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"      varchar NOT NULL,
                    "employeeId"    uuid NOT NULL,
                    title           varchar NOT NULL,
                    description     text,
                    category        varchar,
                    priority        %1$I.goals_priority_enum NOT NULL DEFAULT ''MEDIUM'',
                    status          %1$I.goals_status_enum NOT NULL DEFAULT ''NOT_STARTED'',
                    "startDate"     date NOT NULL,
                    "targetDate"    date NOT NULL,
                    "completedDate" date,
                    "progressPercent" numeric(5,2) NOT NULL DEFAULT 0,
                    "keyResults"    jsonb,
                    "alignedReviewId" varchar,
                    "parentGoalId"  uuid,
                    milestones      jsonb,
                    "createdAt"     timestamp NOT NULL DEFAULT now(),
                    "updatedAt"     timestamp NOT NULL DEFAULT now(),
                    "createdBy"     varchar,
                    "updatedBy"     varchar,
                    version         integer NOT NULL,
                    "isDeleted"     boolean NOT NULL DEFAULT false,
                    CONSTRAINT goals_pkey PRIMARY KEY (id),
                    CONSTRAINT goals_parent_fkey FOREIGN KEY ("parentGoalId")
                        REFERENCES %1$I.goals(id),
                    CONSTRAINT goals_employee_fkey FOREIGN KEY ("employeeId")
                        REFERENCES %1$I.employees(id) ON DELETE CASCADE
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_goals_tenant ON %I.goals ("tenantId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_goals_parent ON %I.goals ("parentGoalId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_goals_tenant_employee ON %I.goals ("tenantId", "employeeId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_goals_tenant_priority ON %I.goals ("tenantId", priority)', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_goals_tenant_status ON %I.goals ("tenantId", status)', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_goals_tenant_target ON %I.goals ("tenantId", "targetDate")', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.goals with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.goals already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== performance_reviews =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'performance_reviews'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.performance_reviews (
                    id                  uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"          varchar NOT NULL,
                    "employeeId"        uuid NOT NULL,
                    "reviewerId"        uuid NOT NULL,
                    "periodType"        %1$I.performance_reviews_periodtype_enum NOT NULL,
                    "periodStart"       date NOT NULL,
                    "periodEnd"         date NOT NULL,
                    status              %1$I.performance_reviews_status_enum NOT NULL DEFAULT ''DRAFT'',
                    "selfAssessment"    text,
                    "selfRating"        numeric(3,2),
                    "managerAssessment" text,
                    "managerRating"     numeric(3,2),
                    "finalRating"       numeric(3,2),
                    "competencyRatings" jsonb,
                    strengths           text,
                    "areasForImprovement" text,
                    "developmentPlan"   text,
                    "employeeComments"  text,
                    "reviewerComments"  text,
                    "calibrationNotes"  text,
                    "acknowledgedBy"    varchar,
                    "acknowledgedAt"    timestamptz,
                    "finalizedBy"       varchar,
                    "finalizedAt"       timestamptz,
                    "createdAt"         timestamp NOT NULL DEFAULT now(),
                    "updatedAt"         timestamp NOT NULL DEFAULT now(),
                    "createdBy"         varchar,
                    "updatedBy"         varchar,
                    version             integer NOT NULL,
                    "isDeleted"         boolean NOT NULL DEFAULT false,
                    CONSTRAINT performance_reviews_pkey PRIMARY KEY (id),
                    CONSTRAINT perf_reviews_employee_fkey FOREIGN KEY ("employeeId")
                        REFERENCES %1$I.employees(id) ON DELETE CASCADE,
                    CONSTRAINT perf_reviews_reviewer_fkey FOREIGN KEY ("reviewerId")
                        REFERENCES %1$I.employees(id)
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_perf_review_tenant ON %I.performance_reviews ("tenantId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_perf_review_tenant_employee ON %I.performance_reviews ("tenantId", "employeeId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_perf_review_tenant_period ON %I.performance_reviews ("tenantId", "periodType", "periodStart", "periodEnd")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_perf_review_tenant_reviewer ON %I.performance_reviews ("tenantId", "reviewerId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_perf_review_tenant_status ON %I.performance_reviews ("tenantId", status)', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.performance_reviews with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.performance_reviews already exists -- skipping', schema_rec.schema_name;
        END IF;

        -- ===== employee_kpis =====
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = schema_rec.schema_name AND table_name = 'employee_kpis'
        ) THEN
            EXECUTE format('
                CREATE TABLE %1$I.employee_kpis (
                    id                  uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "tenantId"          varchar NOT NULL,
                    "employeeId"        uuid NOT NULL,
                    name                varchar NOT NULL,
                    description         text,
                    category            varchar NOT NULL,
                    "targetValue"       numeric(12,2) NOT NULL,
                    "currentValue"      numeric(12,2) NOT NULL DEFAULT 0,
                    unit                varchar,
                    "periodStart"       date NOT NULL,
                    "periodEnd"         date NOT NULL,
                    weight              numeric(5,2) NOT NULL DEFAULT 1,
                    "achievementPercent" numeric(5,2) NOT NULL DEFAULT 0,
                    "createdAt"         timestamp NOT NULL DEFAULT now(),
                    "updatedAt"         timestamp NOT NULL DEFAULT now(),
                    "createdBy"         varchar,
                    "updatedBy"         varchar,
                    version             integer NOT NULL,
                    "isDeleted"         boolean NOT NULL DEFAULT false,
                    CONSTRAINT employee_kpis_pkey PRIMARY KEY (id),
                    CONSTRAINT kpis_employee_fkey FOREIGN KEY ("employeeId")
                        REFERENCES %1$I.employees(id) ON DELETE CASCADE
                )', schema_rec.schema_name);

            EXECUTE format('CREATE INDEX idx_kpis_tenant ON %I.employee_kpis ("tenantId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_kpis_tenant_category ON %I.employee_kpis ("tenantId", category)', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_kpis_tenant_employee ON %I.employee_kpis ("tenantId", "employeeId")', schema_rec.schema_name);
            EXECUTE format('CREATE INDEX idx_kpis_tenant_period ON %I.employee_kpis ("tenantId", "periodStart", "periodEnd")', schema_rec.schema_name);

            RAISE NOTICE 'Created table %.employee_kpis with indexes', schema_rec.schema_name;
        ELSE
            RAISE NOTICE 'Table %.employee_kpis already exists -- skipping', schema_rec.schema_name;
        END IF;

    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- STEP 7: VERIFY final state
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    schema_rec RECORD;
    tbl_count  INTEGER;
    expected_new TEXT[] := ARRAY[
        'tasks', 'auto_rules', 'recurring_templates',
        'device_groups', 'device_group_members',
        'goals', 'performance_reviews', 'employee_kpis', 'departments_hr'
    ];
    dropped_phantoms TEXT[] := ARRAY['user_consents', 'gdpr_data_requests'];
    tbl TEXT;
    missing_tables TEXT[] := '{}';
    lingering_phantoms TEXT[] := '{}';
BEGIN
    FOR schema_rec IN
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
        ORDER BY schema_name
    LOOP
        missing_tables := '{}';
        lingering_phantoms := '{}';

        -- Check expected new tables exist
        FOREACH tbl IN ARRAY expected_new
        LOOP
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = schema_rec.schema_name AND table_name = tbl
            ) THEN
                missing_tables := missing_tables || tbl;
            END IF;
        END LOOP;

        -- Check phantom tables are gone
        FOREACH tbl IN ARRAY dropped_phantoms
        LOOP
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = schema_rec.schema_name AND table_name = tbl
            ) THEN
                lingering_phantoms := lingering_phantoms || tbl;
            END IF;
        END LOOP;

        -- Count total tables
        SELECT count(*) INTO tbl_count
        FROM information_schema.tables
        WHERE table_schema = schema_rec.schema_name;

        IF array_length(missing_tables, 1) IS NOT NULL THEN
            RAISE WARNING '% -- MISSING tables: %', schema_rec.schema_name, missing_tables;
        END IF;

        IF array_length(lingering_phantoms, 1) IS NOT NULL THEN
            RAISE WARNING '% -- LINGERING phantom tables: %', schema_rec.schema_name, lingering_phantoms;
        END IF;

        IF array_length(missing_tables, 1) IS NULL AND array_length(lingering_phantoms, 1) IS NULL THEN
            RAISE NOTICE '% -- OK (% tables)', schema_rec.schema_name, tbl_count;
        END IF;

    END LOOP;
END $$;


COMMIT;


-- =============================================================================
-- ROLLBACK COMMANDS (run manually if needed)
-- =============================================================================
-- WARNING: Only roll back if no data has been inserted into the new tables.
--
-- -- Drop new tables (reverse of STEP 4-6)
-- DO $$
-- DECLARE
--     schema_rec RECORD;
--     new_tables TEXT[] := ARRAY[
--         'employee_kpis', 'performance_reviews', 'goals', 'departments_hr',
--         'device_group_members', 'device_groups',
--         'recurring_templates', 'auto_rules', 'tasks'
--     ];
--     tbl TEXT;
-- BEGIN
--     FOR schema_rec IN
--         SELECT schema_name FROM information_schema.schemata
--         WHERE schema_name LIKE 'tenant_%'
--         ORDER BY schema_name
--     LOOP
--         FOREACH tbl IN ARRAY new_tables
--         LOOP
--             IF EXISTS (
--                 SELECT 1 FROM information_schema.tables
--                 WHERE table_schema = schema_rec.schema_name AND table_name = tbl
--             ) THEN
--                 EXECUTE format('DROP TABLE %I.%I CASCADE', schema_rec.schema_name, tbl);
--                 RAISE NOTICE 'Rolled back: dropped %.%', schema_rec.schema_name, tbl;
--             END IF;
--         END LOOP;
--     END LOOP;
-- END $$;
--
-- -- Drop new enum types (reverse of STEP 2-3)
-- DO $$
-- DECLARE
--     schema_rec RECORD;
--     enum_types TEXT[] := ARRAY[
--         'tasks_category_enum', 'tasks_priority_enum', 'tasks_status_enum',
--         'auto_rules_trigger_enum', 'auto_rules_taskcategory_enum', 'auto_rules_taskpriority_enum',
--         'recurring_templates_category_enum', 'recurring_templates_frequency_enum', 'recurring_templates_priority_enum',
--         'goals_priority_enum', 'goals_status_enum',
--         'performance_reviews_periodtype_enum', 'performance_reviews_status_enum',
--         'departments_hr_type_enum'
--     ];
--     et TEXT;
-- BEGIN
--     FOR schema_rec IN
--         SELECT schema_name FROM information_schema.schemata
--         WHERE schema_name LIKE 'tenant_%'
--         ORDER BY schema_name
--     LOOP
--         FOREACH et IN ARRAY enum_types
--         LOOP
--             IF EXISTS (
--                 SELECT 1 FROM pg_type t
--                 JOIN pg_namespace n ON t.typnamespace = n.oid
--                 WHERE n.nspname = schema_rec.schema_name AND t.typname = et
--             ) THEN
--                 EXECUTE format('DROP TYPE %I.%I CASCADE', schema_rec.schema_name, et);
--                 RAISE NOTICE 'Rolled back: dropped enum %.%', schema_rec.schema_name, et;
--             END IF;
--         END LOOP;
--     END LOOP;
-- END $$;
--
-- -- Re-create phantom tables (reverse of STEP 1)
-- DO $$
-- DECLARE
--     schema_rec RECORD;
-- BEGIN
--     FOR schema_rec IN
--         SELECT schema_name FROM information_schema.schemata
--         WHERE schema_name LIKE 'tenant_%'
--         ORDER BY schema_name
--     LOOP
--         EXECUTE format('CREATE TABLE IF NOT EXISTS %I.user_consents (LIKE farm.user_consents INCLUDING ALL)', schema_rec.schema_name);
--         EXECUTE format('CREATE TABLE IF NOT EXISTS %I.gdpr_data_requests (LIKE farm.gdpr_data_requests INCLUDING ALL)', schema_rec.schema_name);
--         RAISE NOTICE 'Rolled back: re-created phantom tables in %', schema_rec.schema_name;
--     END LOOP;
-- END $$;
