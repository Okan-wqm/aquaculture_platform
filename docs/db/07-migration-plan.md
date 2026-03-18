# Database Architecture Migration Plan

> **Created:** 2026-03-18
> **Scope:** All findings from `08-audit-findings.md`
> **Approach:** Ordered by dependency and risk. Each phase can be deployed and verified independently.

This plan addresses every finding from the architecture audit (C1--C6, H1--H6, M1--M6). Changes are grouped into phases ordered by dependency: later phases assume earlier phases are complete. Each task references the specific audit finding it resolves and the files that must change.

---

## Current State (Already Completed)

The following fixes have already been applied in the current branch. They are listed here so reviewers can confirm they are merged before proceeding to Phase 1.

| Finding | Fix | Status |
|---------|-----|--------|
| C1 (partial) | 11 missing tables added to `MODULE_SCHEMAS` in `schema-manager.service.ts` | Done |
| C2 | sensor-service middleware rewritten: throws `UnauthorizedException` on missing schema, no silent fallback | Done |
| C3 | hr-service middleware rewritten: throws `UnauthorizedException` on missing schema, both fallback paths removed | Done |
| C4 | alert-engine: `TenantSchemaMiddleware` + `TenantConnectionBootstrap` added, alert module registered in `MODULE_SCHEMAS` (5 tables), `createTenantSchema` default modules includes `'alert'` | Done |
| C6 (partial) | Farm `Worker` entity table renamed to `farm_workers` in `MODULE_SCHEMAS` | Done |
| H1 | 14 phantom security/compliance tables removed from farm `MODULE_SCHEMAS` | Done |
| H5 (partial) | Sensor `audit_logs` renamed to `sensor_audit_logs` in `MODULE_SCHEMAS` | Done |
| H6 | `hydroponics` and `ai` schemas already present in `00-init-schemas.sh` (lines 86--87) | Done |
| N/A | `TenantConnectionBootstrap` added to sensor, hr, farm, hydroponics, ai, alert-engine services | Done |
| N/A | All 6 module services now use AsyncLocalStorage-based pool patching instead of per-request QueryRunner | Done |
| N/A | AI module added to `MODULE_SCHEMAS` (3 tables: agent_conversations, tenant_agent_configs, tool_execution_audit) | Done |

**What remains:** The `MODULE_SCHEMAS` constants are updated, but the *live database* has not been migrated yet. Existing tenant schemas still have the old table set. The tasks below address the remaining code changes and the data migration.

---

## Phase 1: Stop the Bleeding (Critical -- Immediate)

**Goal:** Eliminate all remaining paths where tenant data can land in a shared schema.

**Prerequisites:** None. This phase is safe to deploy first.

### 1.1 Remove Hardcoded Schema from equipment_types Entity

**Resolves:** H2

**File:** `apps/farm-service/src/equipment/entities/equipment-type.entity.ts`

**Change:**

```typescript
// BEFORE (bypasses search_path)
@Entity('equipment_types', { schema: 'farm' })

// AFTER (resolved via search_path)
@Entity('equipment_types')
```

**Risk:** LOW -- `search_path` already includes `farm` as fallback, so resolution is unchanged. The only behavioral difference is that tenant schemas now take priority over the source schema, which is the correct behavior.

**Verification:** After deployment, run `EXPLAIN SELECT * FROM equipment_types;` within a tenant connection and confirm the plan references `tenant_xxx.equipment_types`, not `farm.equipment_types`.

---

### 1.2 Remove Hardcoded Schema from Raw SQL

**Resolves:** H3

**Files:**
- `apps/sensor-service/src/automation/automation.service.ts`
- `apps/sensor-service/src/mqtt-listener/mqtt-listener.service.ts`

**Change:** Replace all occurrences of `"sensor"."deployment_logs"` with `"deployment_logs"` (unqualified). The connection's `search_path` will resolve the table to the correct tenant schema.

**Risk:** LOW -- same resolution logic as 1.1.

**Verification:** Grep the entire codebase for hardcoded schema qualifiers in raw SQL:

```bash
grep -rn '"sensor"\."' apps/sensor-service/src --include="*.ts"
grep -rn '"farm"\."' apps/farm-service/src --include="*.ts"
grep -rn '"hr"\."' apps/hr-service/src --include="*.ts"
```

All results must be reviewed. Cross-schema reads (e.g., a module service reading from `auth`) are acceptable; same-schema hardcoding is not.

---

### 1.3 Rename farm Worker Entity Table (Code Side)

**Resolves:** C6

The `MODULE_SCHEMAS` constant already lists `farm_workers` (verified in current branch). This task ensures the entity decorator and any raw SQL references also use the new name.

**Files:**
- `apps/farm-service/src/worker/entities/worker.entity.ts` -- change `@Entity('employees')` to `@Entity('farm_workers')`
- Any raw SQL in farm-service referencing the `employees` table for farm workers

**Risk:** MEDIUM -- requires coordinated deployment with Phase 4.3 (data migration). The entity rename and data migration must happen in the same maintenance window.

**Verification:**

```bash
grep -rn "@Entity('employees')" apps/farm-service/src --include="*.ts"
# Should return zero results after the fix
```

---

### 1.4 Rename sensor audit_logs Entity Table (Code Side)

**Resolves:** H5

The `MODULE_SCHEMAS` constant already lists `sensor_audit_logs`. This task ensures the entity decorator matches.

**Files:**
- `apps/sensor-service/src/infrastructure/audit/audit-log.entity.ts` -- change `@Entity('audit_logs')` to `@Entity('sensor_audit_logs')`
- Any raw SQL in sensor-service referencing `audit_logs`

**Risk:** MEDIUM -- same coordination requirement as 1.3.

---

## Phase 2: Structural Fixes (High Priority)

**Goal:** Add tenant isolation to the alert-engine and fix cron jobs that bypass tenant schemas.

**Prerequisites:** Phase 1 merged and deployed. Middleware fixes (C2/C3) already complete.

### 2.1 Add Schema Isolation to alert-engine -- CODE COMPLETE

**Resolves:** C4

> **Status: CODE COMPLETE (2026-03-18)** -- All code changes for alert-engine schema isolation have been merged:
> - `apps/alert-engine/src/middleware/tenant-schema.middleware.ts` -- created
> - `apps/alert-engine/src/infrastructure/tenant-connection-bootstrap.service.ts` -- created
> - `apps/alert-engine/src/app.module.ts` -- updated with middleware chain + bootstrap
> - `libs/backend-common/src/database/schema-manager.service.ts` -- alert module added to MODULE_SCHEMAS
>
> **Remaining:** Data migration from shared `alert` schema to tenant schemas (Phase 4.2). Alert tables currently store all tenant data in the shared `alert` schema with row-level `tenantId` filtering. Existing data must be migrated to tenant schemas.

---

### 2.2 Fix Cron Jobs to Iterate Tenant Schemas

**Resolves:** C5

All cron jobs listed below currently execute against the source schema. They must be rewritten to iterate tenant schemas using the QueryRunner pattern documented in `docs/db/05-cron-job-patterns.md`.

#### farm-service cron jobs (16 methods)

| File | Method | Lines |
|------|--------|-------|
| `scheduler/cron-jobs.service.ts` | `generateMaintenanceWorkOrders` | 219 |
| `scheduler/cron-jobs.service.ts` | `checkOverdueMaintenance` | 265 |
| `scheduler/cron-jobs.service.ts` | `checkOverdueWorkOrders` | 323 |
| `scheduler/cron-jobs.service.ts` | `checkLowStock` | 380 |
| `scheduler/cron-jobs.service.ts` | `weeklyMaintenanceSummary` | 437 |
| `scheduler/cron-jobs.service.ts` | `monthlyComplianceReport` | 497 |
| `scheduler/cron-jobs.service.ts` | `cleanupOldData` | 537 |
| `scheduler/feeding-scheduler.service.ts` | `generateDailyFeedingPlan` | 732 |
| `scheduler/feeding-scheduler.service.ts` | `sendFeedingReminders` | 762 |
| `scheduler/feeding-scheduler.service.ts` | `dailyFeedingSummary` | 803 |
| `scheduler/feeding-scheduler.service.ts` | `analyzeFCR` | 842 |
| `scheduler/feeding-scheduler.service.ts` | `checkFeedStock` | 887 |
| `scheduler/feeding-scheduler.service.ts` | `weeklyFeedForecast` | 937 |
| `task/services/task.service.ts` | `detectOverdueTasks` | 518 |
| `task/services/recurring-task.service.ts` | `generateDueTasks` | 143 |
| `task/services/auto-rule-trigger.service.ts` | `processScheduleRules` | 187 |

**Required changes per method:**
1. Add `DataSource` injection to the constructor (if not already present).
2. Query `information_schema.schemata` for all `tenant_%` schemas.
3. For each schema, create a `QueryRunner`, set `search_path`, execute logic, release.
4. Use `queryRunner.manager` instead of injected repositories.
5. Catch errors per tenant (do not abort on one tenant's failure).
6. `RESET search_path` and release `QueryRunner` in `finally` block.

**Reference implementation:** `apps/farm-service/src/feeding/services/feeding-cron.service.ts` -- `cleanupOldExecutions()` (line 612). This is the only cron method that currently handles tenant iteration correctly.

#### sensor-service cron jobs (1 method)

| File | Method | Lines |
|------|--------|-------|
| `edge-device/edge-device.service.ts` | `markStaleDevicesOffline` | 688 |

Same pattern, but use `sensor` as the source schema in `search_path`.

**Risk:** LOW -- adds functionality without breaking existing behavior. Cron jobs currently process zero rows (source schemas are empty for correctly provisioned tenants), so the change makes them actually work.

**Verification per method:**
1. Add a test tenant with known data in its schema.
2. Trigger the cron manually (or wait for the next interval).
3. Confirm the data is processed correctly within the tenant schema.
4. Confirm no data is written to or read from the source schema.

---

## Phase 3: Cleanup (Medium Priority)

**Goal:** Remove dead code, resolve duplicate tables, and clean up the database.

**Prerequisites:** Phases 1 and 2 complete. These tasks do not affect data isolation but reduce maintenance burden.

### 3.1 Resolve Auth/Admin Duplicate Tables

**Resolves:** H4

Six table pairs exist in both `auth` and `admin` schemas with different column structures:

| Table | Recommended Owner | Action for Other Schema |
|-------|------------------|------------------------|
| `announcements` | `auth` | Drop from `admin`, add view or API |
| `announcement_acknowledgments` | `auth` | Drop from `admin` |
| `support_tickets` | `auth` | Drop from `admin`, add view |
| `ticket_comments` | `auth` | Drop from `admin` |
| `message_threads` | `auth` | Drop from `admin`, add view |
| `messages` | `auth` | Drop from `admin` |

**Rationale:** These are user-facing entities (users create tickets, send messages, acknowledge announcements). The auth-service owns user identity, so it is the natural owner. The admin-api-service should read this data via cross-schema `SELECT` grants (already configured in `00-init-schemas.sh` lines 253--258) or via an internal API.

**Steps:**
1. Audit which service currently writes to which schema's copy of each table.
2. Migrate any data from the non-canonical copy to the canonical copy.
3. Update the non-owner service to read from the owner schema (cross-schema query or API call).
4. Drop the duplicate tables from the non-owner schema.
5. Remove the entity registrations from the non-owner service.

**Risk:** HIGH -- requires careful data consolidation and service coordination. Test thoroughly in staging.

---

### 3.2 Remove Orphan Entities

**Resolves:** M2

| Service | Entity | Action |
|---------|--------|--------|
| farm | `SiteContact` | Wire into `forFeature()` if used by site management, or delete |
| farm | `SupplierSite` | Wire into `forFeature()` if used by supplier management, or delete |
| sensor | `SensorMetadata` | Delete (0-byte empty file) |
| sensor | `SensorMetric` | Convert to TypeScript interface (used only to type raw SQL results) |
| sensor | `TenantProvisioningKey` | Add to `app.module.ts` entities list |
| sensor | `DeviceEvent` | Add to `app.module.ts` entities list |

**Risk:** LOW for deletions, MEDIUM for wiring changes (may trigger table creation in tenant schemas).

---

### 3.3 Remove Legacy Entities

**Resolves:** M3

| Service | Entity | Table | Action |
|---------|--------|-------|--------|
| farm | `PondBatch` | `batches` | Remove entity file, remove `batches` from `MODULE_SCHEMAS` if `batches_v2` fully replaces it |

**Prerequisite:** Verify no code references the `batches` table (as opposed to `batches_v2`):

```bash
grep -rn "batches[^_v]" apps/farm-service/src --include="*.ts" | grep -v "batches_v2"
grep -rn "'batches'" apps/farm-service/src --include="*.ts"
```

**Risk:** LOW if verification confirms no references.

---

### 3.4 Clean Public Schema

**Resolves:** M4

The `public` schema contains 72 tables with 0 rows, all remnants of the pre-multi-tenant architecture.

**Steps:**
1. Confirm zero application references to public schema tables:
   ```bash
   grep -rn '"public"\.' apps/ --include="*.ts"
   grep -rn "public\." libs/ --include="*.ts" | grep -v "node_modules"
   ```
2. Confirm zero rows in all 72 tables (run against the production database).
3. Generate and review the `DROP TABLE` statements:
   ```sql
   SELECT 'DROP TABLE IF EXISTS "public"."' || tablename || '" CASCADE;'
   FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('spatial_ref_sys')  -- PostGIS system table
   ORDER BY tablename;
   ```
4. Execute in a maintenance window with a full database backup taken beforehand.

**Risk:** MEDIUM -- verify nothing references them first. Extensions like PostGIS and TimescaleDB may own tables in `public`; exclude those.

---

### 3.5 Populate tenant_schemas Tracking Table

**Resolves:** M5

The `admin.tenant_schemas` table is empty despite 5 tenants existing.

**Steps:**
1. Backfill from `pg_namespace`:
   ```sql
   INSERT INTO admin.tenant_schemas (schema_name, created_at, status)
   SELECT nspname, NOW(), 'active'
   FROM pg_catalog.pg_namespace
   WHERE nspname LIKE 'tenant_%'
   ON CONFLICT (schema_name) DO NOTHING;
   ```
2. Update `SchemaManagerService.createTenantSchema()` to insert a record after creating a schema.
3. Update `SchemaManagerService.dropTenantSchema()` to update the record status to `dropped`.

**Risk:** LOW.

---

### 3.6 Activate TimescaleDB for sensor_readings

**Resolves:** M6

**Prerequisite:** TimescaleDB extension is already installed (line 60 of `00-init-schemas.sh`).

**Steps:**
1. Convert `sensor_readings` to a hypertable in each tenant schema:
   ```sql
   -- For each tenant_xxx schema:
   SET search_path TO "tenant_xxx", sensor, public;
   SELECT create_hypertable('sensor_readings', 'timestamp',
     chunk_time_interval => INTERVAL '1 day',
     migrate_data => true,
     if_not_exists => true
   );
   ```
2. Add a compression policy:
   ```sql
   ALTER TABLE sensor_readings SET (
     timescaledb.compress,
     timescaledb.compress_segmentby = '"sensorId"',
     timescaledb.compress_orderby = '"timestamp" DESC'
   );
   SELECT add_compression_policy('sensor_readings', INTERVAL '7 days');
   ```
3. Create continuous aggregates for common dashboard queries (hourly, daily averages).
4. Update the `SchemaManagerService` to create the hypertable during tenant provisioning.

**Risk:** MEDIUM -- the `migrate_data => true` option locks the table during conversion. Schedule during low-traffic periods. For large tenants, consider partitioning existing data first.

---

## Phase 4: Existing Tenant Data Migration

**Goal:** Bring all 5 existing tenant schemas into alignment with the updated `MODULE_SCHEMAS` and fix any data that landed in source schemas.

**Prerequisites:** Phase 1 complete (entity renames done). Phase 2.1 complete for alert tables.

**CRITICAL:** Take a full database backup before starting this phase.

```bash
pg_dump -U aquaculture -Fc aquaculture > backup_$(date +%Y%m%d_%H%M%S).dump
```

### 4.1 Add Missing Tables to Existing Tenant Schemas

For each of the 5 existing tenants, create tables that were added to `MODULE_SCHEMAS` but never provisioned.

**Tables to add per module:**

| Module | New Tables |
|--------|-----------|
| farm | `tasks`, `auto_rules`, `recurring_templates`, `farm_workers` |
| sensor | `lora_devices`, `sensor_audit_logs`, `device_groups`, `device_group_members` |
| hr | `goals`, `performance_reviews`, `employee_kpis` |
| alert | `alert_rules`, `alert_incidents`, `alert_history`, `escalation_policies`, `alert_audit_log` |

**SQL pattern:**

```sql
DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  LOOP
    -- Farm module: new tables
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."tasks" (LIKE "farm"."tasks" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."auto_rules" (LIKE "farm"."auto_rules" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."recurring_templates" (LIKE "farm"."recurring_templates" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."farm_workers" (LIKE "farm"."farm_workers" INCLUDING ALL)',
      tenant_schema
    );

    -- Sensor module: new tables
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."lora_devices" (LIKE "sensor"."lora_devices" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."sensor_audit_logs" (LIKE "sensor"."sensor_audit_logs" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."device_groups" (LIKE "sensor"."device_groups" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."device_group_members" (LIKE "sensor"."device_group_members" INCLUDING ALL)',
      tenant_schema
    );

    -- HR module: new tables
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."goals" (LIKE "hr"."goals" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."performance_reviews" (LIKE "hr"."performance_reviews" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."employee_kpis" (LIKE "hr"."employee_kpis" INCLUDING ALL)',
      tenant_schema
    );

    -- Alert module: new tables (only after Phase 2.1 creates source schema tables)
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."alert_rules" (LIKE "alert"."alert_rules" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."alert_incidents" (LIKE "alert"."alert_incidents" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."alert_history" (LIKE "alert"."alert_history" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."escalation_policies" (LIKE "alert"."escalation_policies" INCLUDING ALL)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I."alert_audit_log" (LIKE "alert"."alert_audit_log" INCLUDING ALL)',
      tenant_schema
    );

    RAISE NOTICE 'Created missing tables in schema %', tenant_schema;
  END LOOP;
END
$$;
```

**Risk:** LOW -- `CREATE TABLE IF NOT EXISTS` is idempotent.

---

### 4.2 Migrate Data from Source Schemas to Tenant Schemas

For tables that existed before being added to `MODULE_SCHEMAS`, tenant data may have been written to the source schema. This data must be migrated to the correct tenant schema.

**Affected tables (data may exist in source schemas):**

| Source Schema | Table | Tenant Key Column |
|---------------|-------|-------------------|
| `farm` | `tasks` | `tenantId` |
| `farm` | `auto_rules` | `tenantId` |
| `farm` | `recurring_templates` | `tenantId` |
| `farm` | `employees` (old name) | `tenantId` |
| `sensor` | `audit_logs` (old name) | `tenantId` |
| `sensor` | `lora_devices` | `tenantId` |
| `sensor` | `device_groups` | `tenantId` |
| `sensor` | `device_group_members` | `tenantId` |
| `hr` | `goals` | `tenantId` |
| `hr` | `performance_reviews` | `tenantId` |
| `hr` | `employee_kpis` | `tenantId` |
| `alert` | `alert_rules` | `tenantId` |
| `alert` | `alert_incidents` | `tenantId` |
| `alert` | `alert_history` | `tenantId` |
| `alert` | `escalation_policies` | `tenantId` |
| `alert` | `alert_audit_log` | `tenantId` |

**Migration procedure per table:**

```sql
-- Step 1: Identify which tenants have data in the source schema
SELECT DISTINCT "tenantId"
FROM {source_schema}.{table_name}
WHERE "tenantId" IS NOT NULL;

-- Step 2: For each tenant, derive the schema name
-- tenant_id -> tenant_{first16hex}

-- Step 3: Copy data (INSERT ... SELECT)
-- Example for farm.tasks:
DO $$
DECLARE
  rec RECORD;
  target_schema TEXT;
BEGIN
  FOR rec IN
    SELECT DISTINCT "tenantId" as tenant_id
    FROM farm.tasks
    WHERE "tenantId" IS NOT NULL
  LOOP
    target_schema := 'tenant_' || left(replace(rec.tenant_id::text, '-', ''), 16);

    -- Verify target schema exists
    IF EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = target_schema
    ) THEN
      -- Insert rows that don't already exist in target (by primary key)
      EXECUTE format(
        'INSERT INTO %I.tasks SELECT * FROM farm.tasks WHERE "tenantId" = $1
         ON CONFLICT (id) DO NOTHING',
        target_schema
      ) USING rec.tenant_id;

      RAISE NOTICE 'Migrated tasks for tenant % to schema %', rec.tenant_id, target_schema;
    ELSE
      RAISE WARNING 'Schema % does not exist for tenant %', target_schema, rec.tenant_id;
    END IF;
  END LOOP;
END
$$;

-- Step 4: After verification, delete migrated rows from source schema
-- DO NOT run this until Step 3 is verified for all tenants
DELETE FROM farm.tasks WHERE "tenantId" IS NOT NULL;
```

**Risk:** HIGH -- data migration. Must be run in a maintenance window with a backup.

**Verification per table:**
1. Count rows in source schema before migration: `SELECT COUNT(*) FROM {source}.{table}`.
2. Run migration.
3. Count rows in each tenant schema: sum should equal the original count.
4. Spot-check 5 random rows by primary key: verify all columns match.
5. Only after verification, delete rows from source schema.

---

### 4.3 Rename Colliding Tables in Tenant Schemas

For existing tenant schemas, rename tables that have name collisions.

**farm `employees` -> `farm_workers`:**

```sql
DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  LOOP
    -- Only rename if the old name exists and the new name doesn't
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = tenant_schema AND table_name = 'employees'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = tenant_schema AND table_name = 'farm_workers'
    ) THEN
      EXECUTE format('ALTER TABLE %I."employees" RENAME TO "farm_workers"', tenant_schema);
      RAISE NOTICE 'Renamed employees -> farm_workers in %', tenant_schema;
    END IF;
  END LOOP;
END
$$;
```

**IMPORTANT:** The HR module also uses `employees`. After renaming the farm copy to `farm_workers`, the `employees` table in tenant schemas must be recreated from the HR source if it does not already exist:

```sql
-- Only if HR employees table was clobbered by the rename:
DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = tenant_schema AND table_name = 'employees'
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I."employees" (LIKE "hr"."employees" INCLUDING ALL)',
        tenant_schema
      );
      RAISE NOTICE 'Recreated HR employees table in %', tenant_schema;
    END IF;
  END LOOP;
END
$$;
```

**sensor `audit_logs` -> `sensor_audit_logs`:**

```sql
DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = tenant_schema AND table_name = 'audit_logs'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = tenant_schema AND table_name = 'sensor_audit_logs'
    ) THEN
      EXECUTE format('ALTER TABLE %I."audit_logs" RENAME TO "sensor_audit_logs"', tenant_schema);
      RAISE NOTICE 'Renamed audit_logs -> sensor_audit_logs in %', tenant_schema;
    END IF;
  END LOOP;
END
$$;
```

**Risk:** MEDIUM -- table renames are non-destructive but must be coordinated with the entity rename in Phase 1.3/1.4. The application code and the database schema must be deployed together.

---

### 4.4 Remove Phantom Tables from Tenant Schemas

The 14 phantom security/compliance tables (formerly in farm `MODULE_SCHEMAS`, now removed) still exist in tenant schemas from previous provisioning runs.

```sql
DO $$
DECLARE
  tenant_schema TEXT;
  phantom_table TEXT;
  phantom_tables TEXT[] := ARRAY[
    'activity_logs', 'api_usage_logs', 'login_attempts', 'user_sessions',
    'user_permissions', 'user_consents', 'compliance_reports', 'gdpr_data_requests',
    'data_requests', 'retention_policies', 'security_events', 'security_incidents',
    'threat_intelligence', 'mobile_user_settings'
  ];
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  LOOP
    FOREACH phantom_table IN ARRAY phantom_tables
    LOOP
      -- Only drop if the table exists AND has zero rows
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = tenant_schema AND table_name = phantom_table
      ) THEN
        EXECUTE format(
          'DO $inner$ BEGIN
             IF (SELECT COUNT(*) FROM %I.%I) = 0 THEN
               DROP TABLE %I.%I CASCADE;
               RAISE NOTICE ''Dropped phantom table %%.%%'', %L, %L;
             ELSE
               RAISE WARNING ''Phantom table %%.%% has data -- skipping'', %L, %L;
             END IF;
           END $inner$',
          tenant_schema, phantom_table,
          tenant_schema, phantom_table,
          tenant_schema, phantom_table,
          tenant_schema, phantom_table
        );
      END IF;
    END LOOP;
  END LOOP;
END
$$;
```

**Risk:** LOW -- these tables should be empty (they were never written to by tenant-scoped operations). The script checks for zero rows before dropping.

---

## Phase 5: Verification

**Goal:** Confirm every finding is resolved and the system is operating correctly.

**Prerequisites:** All previous phases complete.

### 5.1 Per-Service Verification

For each module service (`farm`, `sensor`, `hr`, `hydroponics`, `ai`, `alert-engine`), verify:

- [ ] **Middleware throws on missing schema:** Send a request with a valid JWT for a nonexistent tenant. Expect 401/404, NOT a 200 with source schema data.
- [ ] **All entity tables exist in tenant schemas:** Compare `MODULE_SCHEMAS` tables list against `information_schema.tables` for each `tenant_%` schema. There should be zero missing tables.
- [ ] **No tenant data in source schemas:** For each source schema (`farm`, `sensor`, `hr`, `hydroponics`, `alert`), verify all tables either have zero rows or contain only reference/seed data (no `tenantId` column values).
- [ ] **No hardcoded schema in entity decorators:**
  ```bash
  grep -rn "schema:" apps/*/src/**/*.entity.ts --include="*.ts" | grep -v "node_modules"
  ```
  Should return zero results (or only legitimate cross-schema references).
- [ ] **Cron jobs iterate tenant schemas:** Check logs after cron execution. Each cron should log processing for each tenant schema.

### 5.2 Cross-Service Verification

- [ ] **No duplicate table names:** For each table in every `MODULE_SCHEMAS` entry, confirm no other module lists the same table name.
  ```bash
  # Extract all table names from MODULE_SCHEMAS and check for duplicates
  grep -A1000 'MODULE_SCHEMAS' libs/backend-common/src/database/schema-manager.service.ts \
    | grep "'[a-z_]*'" -o | sort | uniq -d
  ```
- [ ] **No hardcoded schema in raw SQL:**
  ```bash
  grep -rn '"farm"\.\|"sensor"\.\|"hr"\.\|"alert"\.\|"hydroponics"\.' apps/ --include="*.ts" \
    | grep -v node_modules | grep -v ".spec.ts" | grep -v ".test.ts"
  ```
- [ ] **Gateway forwards tenant context:** Verify the API gateway includes `x-user-payload` (or equivalent) in forwarded requests so downstream services can extract `tenantId`.
- [ ] **Frontend includes JWT:** Verify all frontend API calls include the `Authorization` header with a valid JWT containing the `tenantId` claim.
- [ ] **Phantom tables removed:** Verify none of the 14 phantom tables exist in any `tenant_%` schema.
- [ ] **tenant_schemas tracking table populated:** `SELECT COUNT(*) FROM admin.tenant_schemas` should equal the number of `tenant_%` schemas in `pg_namespace`.

### 5.3 Automated Verification Script

Run this SQL to generate a comprehensive status report:

```sql
-- 1. Schema count
SELECT 'Total tenant schemas' AS check,
       COUNT(*)::TEXT AS result
FROM pg_namespace WHERE nspname LIKE 'tenant_%';

-- 2. Tables per tenant vs expected
WITH expected AS (
  SELECT unnest(ARRAY[
    -- farm (67 tables after cleanup)
    'farms','sites','departments','ponds','tanks','tank_allocations','tank_batches',
    'tank_operations','batches','batches_v2','batch_documents','batch_feed_assignments',
    'batch_locations','species','systems','sub_systems','equipment_types','equipment',
    'equipment_systems','sub_equipment_types','sub_equipment','feeder_calibrations',
    'maintenance_schedules','work_orders','spare_parts','feed_types','feed_type_species',
    'feeds','feed_inventory','feed_sites','feeding_protocols','feeding_records',
    'feeding_tables','feeding_programs','feeding_program_tanks','daily_feeding_executions',
    'chemical_types','chemicals','chemical_sites','growth_measurements','mortality_records',
    'water_quality_measurements','health_events','harvest_plans','harvest_records',
    'supplier_types','suppliers','supplier_sites','site_contacts','code_sequences',
    'farm_audit_logs','storage_locations','consumables','storage_inventory','stock_movements',
    'purchase_orders','purchase_order_items','regulatory_settings','sentinel_hub_settings',
    'weather_observations','marine_observations','weather_settings',
    'tasks','auto_rules','recurring_templates','farm_workers',
    -- sensor (35 tables)
    'sensors','sensor_readings','sensor_metrics','sensor_data_channels','sensor_protocols',
    'processes','vfd_devices','vfd_readings','vfd_register_mappings','dashboard_layouts',
    'edge_devices','device_io_configs','plc_connections','plc_alarms','plc_telemetry',
    'feeding_parameters','automation_programs','program_steps','program_transitions',
    'program_variables','step_actions','sensor_type_definitions','industry_templates',
    'channel_detection_log','tenant_provisioning_keys','device_events','deployment_logs',
    'scada_packages','scada_deploy_logs','unified_tags',
    'lora_devices','device_groups','device_group_members','sensor_audit_logs',
    -- hr (24 tables)
    'employees','payrolls','departments_hr','leave_types','leave_balances','leave_requests',
    'shifts','schedules','schedule_entries','scheduling_settings','attendance_records',
    'weekly_plans','weekly_plan_entries','holidays','training_courses','training_enrollments',
    'certification_types','employee_certifications','work_areas','work_rotations',
    'safety_training_records','goals','performance_reviews','employee_kpis',
    -- hydroponics (1 table)
    'hydroponics_config',
    -- alert (5 tables)
    'alert_rules','alert_incidents','alert_history','escalation_policies','alert_audit_log'
  ]) AS table_name
)
SELECT s.nspname AS schema_name,
       COUNT(t.table_name) AS actual_tables,
       (SELECT COUNT(*) FROM expected) AS expected_tables,
       (SELECT COUNT(*) FROM expected) - COUNT(t.table_name) AS missing
FROM pg_namespace s
LEFT JOIN information_schema.tables t
  ON t.table_schema = s.nspname
  AND t.table_name IN (SELECT table_name FROM expected)
WHERE s.nspname LIKE 'tenant_%'
GROUP BY s.nspname
ORDER BY s.nspname;

-- 3. Check for data in source schemas (should be only reference data)
SELECT 'farm' AS source_schema,
       tablename,
       (xpath('/row/cnt/text()',
         query_to_xml(format('SELECT COUNT(*) AS cnt FROM farm.%I', tablename), false, true, '')
       ))[1]::text::int AS row_count
FROM pg_tables
WHERE schemaname = 'farm'
  AND tablename NOT IN ('equipment_types','sub_equipment_types','supplier_types','chemical_types','feed_types')
HAVING (xpath('/row/cnt/text()',
  query_to_xml(format('SELECT COUNT(*) AS cnt FROM farm.%I', tablename), false, true, '')
))[1]::text::int > 0;

-- 4. Check for phantom tables in tenant schemas
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema LIKE 'tenant_%'
  AND table_name IN (
    'activity_logs','api_usage_logs','login_attempts','user_sessions',
    'user_permissions','user_consents','compliance_reports','gdpr_data_requests',
    'data_requests','retention_policies','security_events','security_incidents',
    'threat_intelligence','mobile_user_settings'
  )
ORDER BY table_schema, table_name;
```

---

## Rollback Plan

Each phase can be rolled back independently:

| Phase | Rollback Method | Data Impact |
|-------|----------------|-------------|
| Phase 1 | `git revert` the code changes | None -- source schema resolution still works via `search_path` fallback |
| Phase 2.1 | `git revert` + drop alert module from `MODULE_SCHEMAS` | Alert data remains in shared `alert` schema (pre-migration state) |
| Phase 2.2 | `git revert` the cron job changes | Cron jobs return to source-schema-only execution (broken but not worse than before) |
| Phase 3 | `git revert` + restore dropped tables from backup | Depends on specific task |
| Phase 4.1 | Drop newly created tables in tenant schemas | No data loss (tables are empty at creation) |
| Phase 4.2 | Restore source schema data from backup | Tenant schema copies remain (harmless duplicates) |
| Phase 4.3 | Rename tables back to original names | Coordinate with entity decorator revert |
| Phase 4.4 | Recreate phantom tables from backup | No functional impact |

---

## Execution Timeline

| Week | Phase | Effort | Downtime |
|------|-------|--------|----------|
| 1 | Phase 1 (hardcoded schemas, entity renames) | 1 day code, 1 day review | Zero -- backward compatible |
| 2 | Phase 2.2 (cron job fixes) | 2-3 days code, 1 day review | Zero -- additive change |
| 3 | Phase 2.1 (alert-engine isolation) | 3-4 days code, 2 days review | 15 min maintenance window for data migration |
| 4 | Phase 4 (tenant data migration) | 1 day scripting, 1 day execution | 30 min maintenance window |
| 4 | Phase 5 (verification) | 1 day | Zero |
| 5+ | Phase 3 (cleanup) | 2-3 days per task, ongoing | Zero for code changes; 15 min per table drop |

---

## Summary

| Metric | Value |
|--------|-------|
| Total findings addressed | 18 (6 critical, 6 high, 6 medium) |
| Already completed (code) | 11 (C1, C2, C3, C4, C6 partial, H1, H5 partial, H6, TenantConnectionBootstrap x6, AI module) |
| Remaining code changes | ~10 files across 4 services (Phase 1 entity renames, Phase 2.2 cron fixes, Phase 3 cleanup) |
| Data migration scope | Existing tenants need new tables created + data migrated from source schemas |
| Estimated remaining effort | 2-3 weeks |
| Maximum downtime per window | 30 minutes |

Each finding in `08-audit-findings.md` maps to a specific task above. Cross-reference by finding ID (C1--C6, H1--H6, M1--M6) to confirm complete coverage.
