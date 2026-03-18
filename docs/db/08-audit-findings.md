# Database Architecture Audit Findings

> **Audit date:** 2026-03-18
> **Scope:** All backend services (farm, sensor, hr, hydroponics, ai, auth, admin, alert-engine), init SQL, TypeORM entity/module registration, middleware, cron jobs.
> **Methodology:** Static analysis of entity files, MODULE_SCHEMAS constants, middleware source, raw SQL queries, init scripts, and live database inspection.

Findings are grouped by severity. Each finding has a corresponding fix task in `07-migration-plan.md`.

---

## CRITICAL — Data Isolation Violations

These findings mean tenant data is written to or read from the wrong schema, breaking multi-tenant isolation guarantees.

### C1: 11 Entity Tables Missing from MODULE_SCHEMAS -- RESOLVED

> **Status: RESOLVED (2026-03-18)** -- All 11 tables have been added to their respective `MODULE_SCHEMAS` entries. Farm `employees` (Worker) has been renamed to `farm_workers`. Sensor `audit_logs` has been renamed to `sensor_audit_logs`. Existing tenant schemas still need the tables created and data migrated (see `07-migration-plan.md` Phase 4).

| # | Service | Table | Entity File | Resolution |
|---|---------|-------|-------------|------------|
| 1 | farm | `tasks` | `task/entities/task.entity.ts` | Added to MODULE_SCHEMAS |
| 2 | farm | `auto_rules` | `task/entities/auto-rule.entity.ts` | Added to MODULE_SCHEMAS |
| 3 | farm | `recurring_templates` | `task/entities/recurring-template.entity.ts` | Added to MODULE_SCHEMAS |
| 4 | farm | `farm_workers` | `worker/entities/worker.entity.ts` | Added as `farm_workers` (renamed from `employees`) |
| 5 | sensor | `lora_devices` | `edge-device/entities/lora-device.entity.ts` | Added to MODULE_SCHEMAS |
| 6 | sensor | `sensor_audit_logs` | `infrastructure/audit/audit-log.entity.ts` | Added as `sensor_audit_logs` (renamed from `audit_logs`) |
| 7 | sensor | `device_groups` | `device-group/entities/device-group.entity.ts` | Added to MODULE_SCHEMAS |
| 8 | sensor | `device_group_members` | `device-group/entities/device-group-member.entity.ts` | Added to MODULE_SCHEMAS |
| 9 | hr | `goals` | `performance/entities/goal.entity.ts` | Added to MODULE_SCHEMAS |
| 10 | hr | `performance_reviews` | `performance/entities/performance-review.entity.ts` | Added to MODULE_SCHEMAS |
| 11 | hr | `employee_kpis` | `performance/entities/kpi.entity.ts` | Added to MODULE_SCHEMAS |

---

### C2: Sensor-Service Silent Fallback -- RESOLVED

> **Status: RESOLVED (2026-03-18)** -- The sensor-service middleware has been rewritten. It now throws `UnauthorizedException` when an authenticated tenant's schema does not exist. No silent fallback.

---

### C3: HR-Service Double Silent Fallback -- RESOLVED

> **Status: RESOLVED (2026-03-18)** -- The hr-service middleware has been rewritten. Both the primary `else` branch and the outer `catch` block now throw `UnauthorizedException` for authenticated requests with missing schemas. No silent fallback.

---

### C4: Alert-Engine Has No Schema Isolation -- RESOLVED

> **Status: RESOLVED (2026-03-18)** -- The alert-engine now has:
> - `TenantSchemaMiddleware` at `apps/alert-engine/src/middleware/tenant-schema.middleware.ts`
> - `TenantConnectionBootstrapService` at `apps/alert-engine/src/infrastructure/tenant-connection-bootstrap.service.ts`
> - Alert module registered in `MODULE_SCHEMAS` with 5 tables
>
> Remaining work: migrate existing data from the shared `alert` schema to tenant schemas (see `07-migration-plan.md` Phase 4.2).

---

### C5: Cron Jobs Bypass Tenant Schemas

Scheduled tasks run outside the HTTP request lifecycle, so the `TenantSchemaMiddleware` never fires. All cron jobs execute against the default `search_path` (the source schema), meaning they only see data that was written to the source schema — which, for correctly provisioned tenants, is empty.

| Service | Cron Method | What It Misses |
|---------|-------------|----------------|
| farm | `detectOverdueTasks()` | Tasks in tenant schemas never flagged overdue |
| farm | `generateDueTasks()` | Recurring templates in tenant schemas never generate tasks |
| farm | All `cron-jobs.service.ts` methods | Entire cron surface area is tenant-blind |
| sensor | `markStaleDevicesOffline()` | Devices in tenant schemas never marked stale |

**Root cause:** Cron handlers use the default injected repository, which is bound to the source schema. There is no mechanism to iterate over tenant schemas.

**Fix:** Implement a cron orchestrator that:
1. Queries the tenant registry for all active tenant schemas.
2. For each schema, sets `search_path` on a dedicated connection.
3. Executes the cron logic within that schema context.

---

### C6: `employees` Table Name Collision

Two different entities in two different services map to the same table name `employees`:

| Service | Entity Class | Table | Key Columns |
|---------|-------------|-------|-------------|
| farm | `Worker` | `employees` | farm-specific fields (site assignment, role in farm ops) |
| hr | `Employee` | `employees` | HR-specific fields (salary, department, leave balance) |

When both services bootstrap into the same tenant schema, the second service to run `synchronize` will attempt to alter the table created by the first, potentially dropping columns or failing outright.

**Fix:** Rename the farm-service `Worker` entity table to `farm_workers` (or similar) to eliminate the collision.

---

## HIGH — Architecture Issues

These findings do not directly leak data between tenants but create incorrect schema structures, bypass isolation mechanisms, or indicate systemic design problems.

### H1: 14 Phantom Tables in MODULE_SCHEMAS (Farm) -- RESOLVED

> **Status: RESOLVED (2026-03-18)** -- All 14 phantom security/compliance tables have been removed from the farm `MODULE_SCHEMAS` entry. They belong in the `admin` and `auth` schemas only. Existing phantom tables in tenant schemas still need to be dropped (see `07-migration-plan.md` Phase 4.4).

---

### H2: `equipment_types` Hardcoded Schema

**File:** Farm-service entity decorator

```typescript
@Entity('equipment_types', { schema: 'farm' })
```

The `{ schema: 'farm' }` option forces TypeORM to always qualify queries as `"farm"."equipment_types"`, completely bypassing `search_path`. Tenant schemas are never consulted. All tenants share the same equipment types table in the `farm` source schema.

**Fix:** Remove the `schema` option from the entity decorator. The tenant middleware sets `search_path` to the correct schema; the entity should rely on that.

---

### H3: Hardcoded Schema in Raw SQL

**Files:**
- `apps/sensor-service/src/automation/automation.service.ts`
- `apps/sensor-service/src/mqtt-listener/mqtt-listener.service.ts`

Raw SQL queries reference `"sensor"."deployment_logs"` with a hardcoded schema qualifier. This bypasses the tenant `search_path` and always hits the shared `sensor` schema.

**Fix:** Remove the schema qualifier from raw SQL. Use unqualified table names (e.g., `"deployment_logs"`) so that `search_path` resolves them to the correct tenant schema.

---

### H4: Auth/Admin Duplicate Tables (6 Pairs)

Six tables exist in **both** the `auth` and `admin` schemas with different column structures:

| Table | auth schema | admin schema | Conflict |
|-------|-------------|-------------|----------|
| `announcements` | Auth-scoped fields | Admin-scoped fields | Different column sets |
| `announcement_acknowledgments` | FK to auth.announcements | FK to admin.announcements | Broken referential integrity |
| `support_tickets` | User-facing fields | Admin-facing fields | Data split across schemas |
| `ticket_comments` | FK to auth.support_tickets | FK to admin.support_tickets | Orphaned FKs |
| `message_threads` | User-facing | Admin-facing | Duplicate threads |
| `messages` | User-facing | Admin-facing | Duplicate messages |

**Risk:** Writes go to one schema, reads may hit the other. Support ticket workflows are unreliable because the ticket and its comments may live in different schemas.

**Fix:** Designate a single owner schema for each table. Create views or synonyms in the other schema if read access is needed.

---

### H5: `audit_logs` Triple Duplicate -- PARTIALLY RESOLVED

> **Status: PARTIALLY RESOLVED (2026-03-18)** -- The sensor-service `audit_logs` has been renamed to `sensor_audit_logs` in MODULE_SCHEMAS. The farm-service already uses `farm_audit_logs`. The `auth` and `admin` schema copies remain named `audit_logs` (acceptable since they are in separate system schemas, not tenant schemas). The entity decorator in the sensor-service audit log entity may still reference the old name `audit_logs` and needs to be updated to `sensor_audit_logs` (see `07-migration-plan.md` Phase 1.4).

---

### H6: Missing Schemas in Init SQL -- RESOLVED

> **Status: RESOLVED** -- Both `hydroponics` and `ai` schemas are present in `00-init-schemas.sh` (lines 86-87) and in the standalone `infrastructure/database/init-schemas.sql`. This was confirmed during the init-sql reference documentation (see `10-init-sql-reference.md`).

---

## MEDIUM — Redundancy & Cleanup

These findings do not affect correctness or security but increase maintenance burden, waste resources, or indicate dead code.

### M1: Redundant `tenantId` Columns

All module-service entities (farm, sensor, hr, hydroponics) include a `tenantId` column despite data already being isolated by schema. This creates:

- **Storage overhead:** An extra UUID column and index per table per tenant.
- **Developer confusion:** Unclear whether to filter by `tenantId`, rely on schema isolation, or both.
- **Double-filtering cost:** Queries that filter by `tenantId` AND rely on `search_path` do redundant work.

**Recommendation:** Keep `tenantId` as a defense-in-depth measure during the transition period, but mark it as deprecated. Once schema isolation is verified for all entities (C1 resolved), plan removal in a future migration.

---

### M2: Orphan Entities

Entities that exist in the codebase but are not wired into the running application:

| Service | Entity | Issue |
|---------|--------|-------|
| farm | `SiteContact` | Not in any `forFeature()` call |
| farm | `SupplierSite` | Not in any `forFeature()` call |
| sensor | `SensorMetadata` | File is 0 bytes (empty) |
| sensor | `SensorMetric` | Used only in raw SQL, not registered as an entity |
| sensor | `TenantProvisioningKey` | In `forFeature()` but not in `app.module.ts` entities list |
| sensor | `DeviceEvent` | In `forFeature()` but not in `app.module.ts` entities list |

**Risk:** Orphan entities will never have their tables created or migrated. Any code that references them will fail at runtime with "relation does not exist."

**Fix:** Either register these entities properly or delete them if they are no longer needed.

---

### M3: Legacy Entities

| Service | Entity | Table | Status |
|---------|--------|-------|--------|
| farm | `PondBatch` | `batches` | Superseded by `batches_v2` |

The legacy `PondBatch` entity still exists and is still registered. If both `batches` and `batches_v2` tables are created in tenant schemas, there is ambiguity about which table holds the canonical batch data.

**Fix:** Remove `PondBatch` entity after verifying no code references the `batches` table.

---

### M4: Public Schema Dead Zone

The `public` schema contains **72 tables with 0 rows**. These are remnants from the pre-multi-tenant era when all data lived in `public`. They are never written to by the current application.

**Risk:** No functional impact, but they consume catalog space, slow down `\dt` and schema introspection, and confuse developers.

**Fix:** Drop all 72 tables in a controlled migration after confirming zero references in application code.

---

### M5: `tenant_schemas` Tracking Table Empty

**Schema:** `admin`
**Table:** `tenant_schemas`
**Row count:** 0

This table was designed to track which tenant schemas have been provisioned and their current migration version. It is never populated by the provisioning flow. As a result, there is no authoritative registry of tenant schemas — the only way to discover them is to query `pg_namespace` for schemas matching the `tenant_*` pattern.

**Fix:** Update the tenant provisioning code to insert a record into `admin.tenant_schemas` when creating a new tenant schema, and update it after each migration.

---

### M6: TimescaleDB Not Active

TimescaleDB extension is installed but **zero hypertables** exist. The `sensor_readings` table — which stores high-frequency time-series data from IoT sensors — is a regular PostgreSQL table.

**Impact:**
- No automatic partitioning by time range.
- No chunk-level compression.
- No continuous aggregates for dashboards.
- Query performance degrades as data volume grows.

**Fix:** Convert `sensor_readings` to a hypertable:

```sql
SELECT create_hypertable('sensor_readings', 'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  migrate_data => true
);
```

Apply a compression policy for data older than 7 days and create continuous aggregates for common dashboard queries.

---

## Summary Matrix

| Severity | Total | Resolved | Remaining | Theme |
|----------|-------|----------|-----------|-------|
| **CRITICAL** | 6 | 4 (C1, C2, C3, C4) | 2 (C5, C6) | Data isolation violations |
| **HIGH** | 6 | 3 (H1, H5 partial, H6) | 3 (H2, H3, H4) | Structural issues |
| **MEDIUM** | 6 | 0 | 6 (M1-M6) | Cleanup |
| **Total** | **18** | **7** | **11** | |

### Resolved Findings (Code Changes Merged)

- **C1** -- 11 missing tables added to MODULE_SCHEMAS
- **C2** -- Sensor-service middleware: silent fallback removed, now throws UnauthorizedException
- **C3** -- HR-service middleware: double fallback removed, now throws UnauthorizedException
- **C4** -- Alert-engine: TenantSchemaMiddleware + TenantConnectionBootstrap + MODULE_SCHEMAS entry added
- **H1** -- 14 phantom tables removed from farm MODULE_SCHEMAS
- **H5** (partial) -- Sensor `audit_logs` renamed to `sensor_audit_logs` in MODULE_SCHEMAS
- **H6** -- `hydroponics` and `ai` schemas confirmed present in init SQL

### Remaining Priority Order

1. **C5** (Cron Jobs) -- Silent data loss; cron jobs appear to work but process nothing.
2. **C6** (Table Collision) -- Entity decorator renames (`employees` -> `farm_workers`, `audit_logs` -> `sensor_audit_logs`) still pending.
3. **H2** (Hardcoded schema in equipment_types) -- Entity decorator fix.
4. **H3** (Hardcoded schema in raw SQL) -- Remove schema qualifiers.
5. **H4** (Auth/Admin duplicate tables) -- Designate single owner.
6. **M1--M6** (Cleanup) -- Address after critical and high findings are resolved.

Each finding maps to a specific migration task in [`07-migration-plan.md`](./07-migration-plan.md).
