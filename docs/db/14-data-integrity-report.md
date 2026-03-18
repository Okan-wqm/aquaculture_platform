# Data Integrity Report

**Date:** 2026-03-18
**Engineer:** Data Integrity Engineer
**Database:** aquaculture (PostgreSQL + TimescaleDB)
**Tenants:** 5 active tenants

---

## Check 1: Source Schemas — Tenant Data Isolation

**Status: PASS**

Source schemas (`farm`, `sensor`, `hr`) contain **only** reference/seed data. No operational tenant data leaks.

| Schema | Table | Rows | Classification |
|--------|-------|------|----------------|
| farm | equipment_types | 42 | Reference data (OK) |
| farm | chemical_types | 12 | Reference data (OK) |
| farm | supplier_types | 6 | Reference data (OK) |
| farm | weather_settings | 2 | Reference data (OK) |
| sensor | sensor_protocols | 39 | Reference data (OK) |
| sensor | sensor_type_definitions | 15 | Reference data (OK) |
| sensor | edge_devices | 9 | Shared edge devices (OK) |
| sensor | industry_templates | 3 | Reference data (OK) |
| sensor | migrations | 5 | TypeORM internal (OK) |
| hr | (all tables) | 0 | Empty (OK) |

All other tables in source schemas have 0 rows. No isolation violation detected.

---

## Check 2: New Tables in Source Schemas

**Status: PARTIAL — tables exist in source but missing from tenant schemas**

### Farm schema — new tables present:
- `tasks` — EXISTS (0 rows)
- `auto_rules` — EXISTS (0 rows)
- `recurring_templates` — EXISTS (0 rows)
- `farm_workers` — **NOT CREATED** (in MODULE_SCHEMAS but no entity synced yet)

### Sensor schema — new tables present:
- `device_groups` — EXISTS (0 rows)
- `device_group_members` — EXISTS (0 rows)
- `lora_devices` — **NOT CREATED** (in MODULE_SCHEMAS but no entity synced yet)
- `sensor_audit_logs` — **NOT CREATED** (MODULE_SCHEMAS lists `sensor_audit_logs`, DB has `audit_logs`)

### HR schema — new tables present:
- `goals` — EXISTS (0 rows)
- `performance_reviews` — EXISTS (0 rows)
- `employee_kpis` — EXISTS (0 rows)
- `departments_hr` — EXISTS (0 rows)

---

## Check 3: Tenant Schema Consistency — Missing Tables

**Status: FAIL — 11 tables missing from all 5 tenant schemas**

Tables that exist in source schemas but are NOT present in any tenant schema:

### From farm source (3 missing):
| Table | In Source | In Tenant | Action Required |
|-------|-----------|-----------|-----------------|
| tasks | YES | NO | Sync to tenants |
| auto_rules | YES | NO | Sync to tenants |
| recurring_templates | YES | NO | Sync to tenants |

### From sensor source (4 missing):
| Table | In Source | In Tenant | Action Required |
|-------|-----------|-----------|-----------------|
| audit_logs | YES (as `audit_logs`) | NO | Rename to `sensor_audit_logs` or sync as-is |
| device_groups | YES | NO | Sync to tenants |
| device_group_members | YES | NO | Sync to tenants |
| migrations | YES (TypeORM internal) | NO | Do NOT sync — internal table |

### From hr source (4 missing):
| Table | In Source | In Tenant | Action Required |
|-------|-----------|-----------|-----------------|
| departments_hr | YES | NO | Sync to tenants |
| goals | YES | NO | Sync to tenants |
| performance_reviews | YES | NO | Sync to tenants |
| employee_kpis | YES | NO | Sync to tenants |

---

## Check 4: Stale Data in Wrong Schemas

**Status: PASS**

All newly added tables in source schemas have 0 rows:
- `farm.tasks` — 0 rows
- `farm.auto_rules` — 0 rows
- `farm.recurring_templates` — 0 rows
- `sensor.device_groups` — 0 rows
- `sensor.device_group_members` — 0 rows
- `hr.goals` — 0 rows
- `hr.performance_reviews` — 0 rows
- `hr.employee_kpis` — 0 rows

No stale data to migrate.

---

## Check 5: Orphan Data

**Status: PASS (N/A)**

All operational tables in source schemas have 0 rows, so no orphan data referencing non-existent tenants.

---

## Check 6: admin.tenant_schemas Tracking Table

**Status: FAIL — Table exists but is EMPTY (0 rows)**

The `admin.tenant_schemas` table has the correct structure:
- Columns: `id`, `tenantId`, `schemaName`, `status`, `currentVersion`, `sizeBytes`, `tableCount`, `connectionCount`, `maxConnections`, `metadata`, `lastMigrationAt`, `lastBackupAt`, `createdAt`, `updatedAt`
- Has unique constraint on `tenantId`

However, **no tenant schemas are registered**. All 5 active tenants are untracked.

Expected entries for:
| Tenant | Schema |
|--------|--------|
| Ocenfarm as | tenant_7e67d0e83ecd4cb5 |
| Suderra AS | tenant_6590c4ca75ea427e |
| Suderra Labs | tenant_ec398ecf40484802 |
| noras aquaculture | tenant_6975c030ebfc484e |
| noras wt | tenant_c24473483ae94bf4 |

---

## Check 7: Hydroponics, AI, and Alert Schemas

**Status: PARTIAL**

| Schema | Exists | Tables |
|--------|--------|--------|
| alert | YES | 0 (empty) |
| hydroponics | **NO** | N/A |
| ai | **NO** | N/A |

- `alert` schema exists but has no tables (MODULE_SCHEMAS defines 5: `alert_rules`, `alert_incidents`, `escalation_policies`, `alert_history`, `alert_audit_log`).
- `hydroponics` schema does NOT exist. MODULE_SCHEMAS defines 1 table: `hydroponics_config`.
- `ai` schema does NOT exist. Not yet defined in MODULE_SCHEMAS.

---

## Check 8: Tenant Schema Table Count Comparison

**Status: PASS — All tenant schemas are identical**

| Schema | Table Count |
|--------|-------------|
| tenant_6590c4ca75ea427e | 109 |
| tenant_6975c030ebfc484e | 109 |
| tenant_7e67d0e83ecd4cb5 | 109 |
| tenant_c24473483ae94bf4 | 109 |
| tenant_ec398ecf40484802 | 109 |

All 5 tenant schemas have exactly 109 tables. No schema drift between tenants.

---

## Additional Findings

### Finding A: MODULE_SCHEMAS vs DB Name Mismatch
- MODULE_SCHEMAS registers `sensor_audit_logs` but the sensor source schema has the table named `audit_logs`.
- The entity likely uses `@Entity('sensor_audit_logs')` but the table in the `sensor` source schema was created as `audit_logs` (possibly by an older entity definition or manual DDL).

### Finding B: Tables in Source Schemas NOT Registered in MODULE_SCHEMAS
| Schema | Table | Notes |
|--------|-------|-------|
| farm | `employees` | Duplicate — also exists in `hr`. Farm service should NOT own employees. |
| farm | `gdpr_data_requests` | Also in `public`, `admin`, `auth`. Duplicated by TypeORM sync across services. |
| farm | `user_consents` | Also in `public`, `admin`, `auth`. Same duplication issue. |
| sensor | `audit_logs` | Should be `sensor_audit_logs` per MODULE_SCHEMAS. |
| sensor | `migrations` | TypeORM internal table — should NOT be in MODULE_SCHEMAS. |

### Finding C: Tables in MODULE_SCHEMAS NOT Yet Created in Source Schema
| Module | Table | Notes |
|--------|-------|-------|
| sensor | `sensor_metrics` | Defined in MODULE_SCHEMAS, not in sensor source schema |
| sensor | `tenant_provisioning_keys` | Defined in MODULE_SCHEMAS, not in sensor source schema |
| sensor | `device_events` | Defined in MODULE_SCHEMAS, not in sensor source schema |
| sensor | `lora_devices` | Defined in MODULE_SCHEMAS, not in sensor source schema |
| sensor | `sensor_audit_logs` | Defined in MODULE_SCHEMAS, exists as `audit_logs` |
| farm | `supplier_sites` | Defined in MODULE_SCHEMAS, not in farm source schema |
| farm | `site_contacts` | Defined in MODULE_SCHEMAS, not in farm source schema |
| farm | `farm_workers` | Defined in MODULE_SCHEMAS, not in farm source schema |

These entities are registered in code but have not yet been synced to the database (possibly `DATABASE_SYNC=false` or the entities are not yet imported into their modules).

---

## Summary of Required Actions

### Priority 1 — Critical: Populate admin.tenant_schemas

The tracking table is empty. All 5 tenant schemas must be registered.

```sql
-- Fix: Populate admin.tenant_schemas for all existing tenants
INSERT INTO admin.tenant_schemas ("tenantId", "schemaName", status, "currentVersion", "sizeBytes", "tableCount", "connectionCount", "maxConnections", "createdAt", "updatedAt")
SELECT
  t.id,
  'tenant_' || left(replace(t.id::text, '-', ''), 16),
  'active',
  '1.0.0',
  pg_database_size(current_database()) / (SELECT count(*) FROM auth.tenants),
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'tenant_' || left(replace(t.id::text, '-', ''), 16)),
  0,
  10,
  now(),
  now()
FROM auth.tenants t
WHERE t.status = 'ACTIVE'
ON CONFLICT ("tenantId") DO NOTHING;
```

### Priority 2 — High: Sync Missing Tables to Tenant Schemas

10 tables exist in source schemas but not in tenant schemas. These must be created.

```sql
-- Fix: Create missing farm tables in all tenant schemas
DO $$
DECLARE
  schema_rec RECORD;
BEGIN
  FOR schema_rec IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'
  LOOP
    -- tasks
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.tasks (LIKE farm.tasks INCLUDING ALL)', schema_rec.schema_name);
    -- auto_rules
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.auto_rules (LIKE farm.auto_rules INCLUDING ALL)', schema_rec.schema_name);
    -- recurring_templates
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.recurring_templates (LIKE farm.recurring_templates INCLUDING ALL)', schema_rec.schema_name);
  END LOOP;
END $$;

-- Fix: Create missing sensor tables in all tenant schemas
DO $$
DECLARE
  schema_rec RECORD;
BEGIN
  FOR schema_rec IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'
  LOOP
    -- device_groups
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.device_groups (LIKE sensor.device_groups INCLUDING ALL)', schema_rec.schema_name);
    -- device_group_members
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.device_group_members (LIKE sensor.device_group_members INCLUDING ALL)', schema_rec.schema_name);
  END LOOP;
END $$;

-- Fix: Create missing HR tables in all tenant schemas
DO $$
DECLARE
  schema_rec RECORD;
BEGIN
  FOR schema_rec IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'
  LOOP
    -- departments_hr
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.departments_hr (LIKE hr.departments_hr INCLUDING ALL)', schema_rec.schema_name);
    -- goals
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.goals (LIKE hr.goals INCLUDING ALL)', schema_rec.schema_name);
    -- performance_reviews
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.performance_reviews (LIKE hr.performance_reviews INCLUDING ALL)', schema_rec.schema_name);
    -- employee_kpis
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.employee_kpis (LIKE hr.employee_kpis INCLUDING ALL)', schema_rec.schema_name);
  END LOOP;
END $$;
```

**Note:** The `LIKE ... INCLUDING ALL` approach copies column definitions, defaults, constraints, and indexes from the source table. However, foreign key references to other tables may need manual adjustment to point to the tenant schema. Verify FK constraints after running.

### Priority 3 — Medium: Fix Naming Mismatch

```sql
-- Fix: Rename audit_logs to sensor_audit_logs in sensor source schema
ALTER TABLE sensor.audit_logs RENAME TO sensor_audit_logs;
```

### Priority 4 — Medium: Create Missing Source Schemas

```sql
-- Create hydroponics source schema
CREATE SCHEMA IF NOT EXISTS hydroponics;

-- Create ai source schema (when ai-service entities are ready)
CREATE SCHEMA IF NOT EXISTS ai;
```

### Priority 5 — Low: Clean Up Duplicate Tables

The following tables exist in source schemas but are NOT part of that module's domain. They were likely created by TypeORM auto-sync when `search_path` was set to the wrong schema:

```sql
-- These are duplicates created by TypeORM sync leaking across schemas.
-- Safe to drop ONLY after confirming 0 rows and no dependencies.
-- Verify before dropping:
SELECT count(*) FROM farm.employees;        -- Should be 0
SELECT count(*) FROM farm.gdpr_data_requests; -- Should be 0
SELECT count(*) FROM farm.user_consents;     -- Should be 0

-- Drop duplicates (run only after verification):
-- DROP TABLE IF EXISTS farm.employees;
-- DROP TABLE IF EXISTS farm.gdpr_data_requests;
-- DROP TABLE IF EXISTS farm.user_consents;
```

### Priority 6 — Low: Decide on sensor.migrations

The `sensor.migrations` table is TypeORM's internal migration tracking table. It should NOT be listed in MODULE_SCHEMAS and should NOT be synced to tenant schemas. It is correctly excluded from tenant schemas today.

---

## Architecture Compliance Matrix

| Check | Status | Severity | Notes |
|-------|--------|----------|-------|
| 1. No tenant data in source schemas | PASS | - | Only ref/seed data |
| 2. New tables exist in source schemas | PARTIAL | Medium | 8 tables in MODULE_SCHEMAS not yet in DB |
| 3. Tenant schema consistency | FAIL | High | 10 tables missing from all tenant schemas |
| 4. No stale data in wrong schemas | PASS | - | All 0 rows |
| 5. No orphan data | PASS | - | N/A (no data) |
| 6. tenant_schemas tracking populated | FAIL | Critical | 0/5 tenants tracked |
| 7. hydroponics/ai/alert schemas | PARTIAL | Medium | Only alert exists (empty) |
| 8. Tenant schemas identical | PASS | - | All at 109 tables |

**Overall Assessment:** The multi-tenant isolation boundary is intact — no tenant data has leaked into source schemas. However, the new architecture changes (tasks, device groups, performance management) have not been propagated to tenant schemas, and the `admin.tenant_schemas` tracking table is unpopulated. These are deployment-sequence issues, not data corruption issues.
