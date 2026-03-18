# Cross-Document Consistency Check

> **Date:** 2026-03-18
> **Method:** All 12 documentation files cross-referenced against each other and against the actual source code in `libs/backend-common/src/database/schema-manager.service.ts` and service middleware files.

---

## Inconsistencies Found and Fixed

### 1. Farm Module Table Count: 67 vs 66

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `00-architecture-overview.md` | 67 | **66** | CODE: 66 tables in MODULE_SCHEMAS |
| `01-schema-separation.md` | 67 | **66** | CODE |
| `03-module-schemas-registry.md` | 66 | 66 (was correct) | CODE |

**Root cause:** Doc 00 and 01 were written before the 14 phantom security tables were removed and the task/worker tables were added. The net count changed from the original but these docs were not updated. Additionally, doc 00 did not list the alert and ai modules in Tier 2.

---

### 2. Sensor Module Table Count: 31 vs 34

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `00-architecture-overview.md` | 31 | **34** | CODE: 34 tables in MODULE_SCHEMAS |
| `01-schema-separation.md` | 31 (with 4 missing note) | **34** | CODE |
| `03-module-schemas-registry.md` | 34 | 34 (was correct) | CODE |

**Root cause:** Doc 00 and 01 were written before `lora_devices`, `sensor_audit_logs`, `device_groups`, and `device_group_members` were added to MODULE_SCHEMAS. The old count of 31 + 4 missing = 35 but `audit_logs` was renamed to `sensor_audit_logs` (not a net addition), and the 31 already included the base set. Actual count is 34.

---

### 3. Alert-Engine Status: "NEEDS MIGRATION" vs Fully Implemented

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `00-architecture-overview.md` | "NEEDS MIGRATION" | **Schema-level isolation (implemented)** | CODE: middleware + MODULE_SCHEMAS entry exists |
| `01-schema-separation.md` | "NEEDS MIGRATION" | **Registered, 5 tables** | CODE |
| `02-tenant-isolation-rules.md` | Listed in verification checklist | Updated to note alert-engine is correct | CODE |
| `03-module-schemas-registry.md` | "NOT YET REGISTERED" | **Registered with 5 tables** | CODE |
| `04-middleware-patterns.md` | "No Middleware At All" | **CORRECT -- has middleware** | CODE |
| `08-audit-findings.md` | C4: "No Schema Isolation" | **C4: RESOLVED** | CODE |
| `ALERT_ENGINE_SCHEMAS_NEEDED.md` | MODULE_SCHEMAS entry not added | **Entry added, confirmed** | CODE |

**Root cause:** Alert-engine implementation was added to the codebase but documentation was not updated across all affected files.

**Code confirms:**
- `apps/alert-engine/src/middleware/tenant-schema.middleware.ts` -- EXISTS, throws UnauthorizedException
- `apps/alert-engine/src/infrastructure/tenant-connection-bootstrap.service.ts` -- EXISTS
- `MODULE_SCHEMAS` has alert entry with 5 tables
- `createTenantSchema()` default modules: `['sensor', 'farm', 'hr', 'hydroponics', 'alert', 'ai']`

---

### 4. Sensor/HR Middleware: "BROKEN" vs Fixed

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `02-tenant-isolation-rules.md` Rule 7 | sensor/hr "BROKEN" | **CORRECT** | CODE: both throw UnauthorizedException |
| `04-middleware-patterns.md` | sensor "Silent Fallback", hr "Double Silent Fallback" | **Both RESOLVED** | CODE |
| `08-audit-findings.md` | C2/C3 open findings | **C2/C3 RESOLVED** | CODE |

**Code confirms:**
- `apps/sensor-service/src/middleware/tenant-schema.middleware.ts` line 115: `throw new UnauthorizedException(...)`
- `apps/hr-service/src/middleware/tenant-schema.middleware.ts` line 107: `throw new UnauthorizedException(...)`
- Neither has a silent fallback path

---

### 5. Farm `employees` Table Name: Code Uses `farm_workers`

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `01-schema-separation.md` | Listed `employees` with collision warning | **Updated to `farm_workers`** | CODE: MODULE_SCHEMAS lists `farm_workers` |
| `03-module-schemas-registry.md` | `farm_workers` | Correct (was already updated) | CODE |
| `06-entity-guidelines.md` | "Rename to farm_workers (Rule 3)" | **Updated: renamed in MODULE_SCHEMAS; entity decorator pending** | CODE |

**Note:** MODULE_SCHEMAS uses `farm_workers`, but the entity decorator in `worker.entity.ts` may still use `@Entity('employees')`. This is tracked in `07-migration-plan.md` Phase 1.3.

---

### 6. H1/H5/H6 Findings Status Outdated

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `08-audit-findings.md` H1 | Open finding (14 phantom tables) | **RESOLVED** | CODE: phantom tables removed from MODULE_SCHEMAS |
| `08-audit-findings.md` H5 | Open finding (audit_logs triple duplicate) | **PARTIALLY RESOLVED** | CODE: sensor_audit_logs in MODULE_SCHEMAS |
| `08-audit-findings.md` H6 | Open finding (missing hydroponics/ai in init SQL) | **RESOLVED** | CODE: confirmed in `00-init-schemas.sh` |

---

### 7. Doc 00 Missing Alert in Tier 2 and Module Count

| Document | Before | After |
|----------|--------|-------|
| `00-architecture-overview.md` | Tier 2 lists 4 modules, Tier 3 says "ALL 4 modules" | **Tier 2 lists 6 modules (including alert and ai), Tier 3 says "ALL 6 modules"** |

---

### 8. AI Module Missing from Multiple Documents

| Document | Before | After | Source of Truth |
|----------|--------|-------|-----------------|
| `00-architecture-overview.md` | No AI module in Tier 2 | **Added: ai module, 3 tables** | CODE: MODULE_SCHEMAS has ai entry |
| `01-schema-separation.md` | No AI module section | *Not yet added* -- AI module tables not documented | CODE |
| `03-module-schemas-registry.md` | No AI module section | **Added: 3 tables (agent_conversations, tenant_agent_configs, tool_execution_audit)** | CODE |

**Root cause:** The AI module was added to MODULE_SCHEMAS but documentation was not created for it in `01-schema-separation.md`. The overview and registry docs have been updated. A full AI module section should be added to `01-schema-separation.md` in a future documentation pass.

---

### 9. Doc 00 Missing Document References

`00-architecture-overview.md` did not list `15-consistency-check.md` or `ALERT_ENGINE_SCHEMAS_NEEDED.md` in its directory index. Added.

---

## Single Source of Truth Reference

For each key metric, the authoritative source is the **CODE**, specifically `libs/backend-common/src/database/schema-manager.service.ts`. Documentation must be kept in sync with this file.

### Module Table Counts (as of 2026-03-18)

| Module | Source Schema | Table Count | Reference Data Tables | Status |
|--------|-------------|-------------|----------------------|--------|
| sensor | `sensor` | 34 | sensor_protocols, sensor_type_definitions, industry_templates | Aligned |
| farm | `farm` | 66 | equipment_types, sub_equipment_types, supplier_types, chemical_types, feed_types | Aligned |
| hr | `hr` | 24 | leave_types, certification_types, shifts | Aligned |
| hydroponics | `hydroponics` | 1 | (none) | Aligned |
| alert | `alert` | 5 | (none) | Aligned |
| ai | `ai` | 3 | (none) | Aligned |
| **Total** | | **133** | | |

### Service Middleware Status (as of 2026-03-18)

| Service | Middleware | Throws on Missing | Bootstrap | Exception Type | MODULE_SCHEMAS |
|---------|-----------|-------------------|-----------|---------------|----------------|
| farm-service | Yes | Yes | Yes | UnauthorizedException | 66 tables |
| sensor-service | Yes | Yes | Yes | UnauthorizedException | 34 tables |
| hr-service | Yes | Yes | Yes | UnauthorizedException | 24 tables |
| hydroponics-service | Yes | Yes | Yes | UnauthorizedException | 1 table |
| ai-service | Yes | Yes | Yes | UnauthorizedException | 3 tables |
| alert-engine | Yes | Yes | Yes | UnauthorizedException | 5 tables |

### Audit Findings Resolution Status (as of 2026-03-18)

| Finding | Description | Status |
|---------|-------------|--------|
| C1 | 11 entity tables missing from MODULE_SCHEMAS | **RESOLVED** (code) |
| C2 | Sensor-service silent fallback | **RESOLVED** (code) |
| C3 | HR-service double silent fallback | **RESOLVED** (code) |
| C4 | Alert-engine no schema isolation | **RESOLVED** (code + MODULE_SCHEMAS) |
| C5 | Cron jobs bypass tenant schemas | **RESOLVED** |
| C6 | `employees` table name collision | **PARTIALLY RESOLVED** (MODULE_SCHEMAS updated, entity decorator pending) |
| H1 | 14 phantom tables in farm MODULE_SCHEMAS | **RESOLVED** (code) |
| H2 | equipment_types hardcoded schema | **OPEN** |
| H3 | Hardcoded schema in raw SQL | **OPEN** |
| H4 | Auth/admin duplicate tables (6 pairs) | **OPEN** |
| H5 | audit_logs triple duplicate | **PARTIALLY RESOLVED** (sensor renamed in MODULE_SCHEMAS, entity decorator pending) |
| H6 | Missing schemas in init SQL | **RESOLVED** |
| M1 | Redundant tenantId columns | **OPEN** (by design, defense-in-depth) |
| M2 | Orphan entities | **OPEN** |
| M3 | Legacy entities | **OPEN** |
| M4 | Public schema dead zone | **OPEN** |
| M5 | tenant_schemas tracking table empty | **OPEN** |
| M6 | TimescaleDB not active | **OPEN** |

### Document Index with Accuracy Status

| Document | Accuracy After This Check |
|----------|--------------------------|
| `00-architecture-overview.md` | FIXED -- table counts, alert status, module count corrected |
| `01-schema-separation.md` | FIXED -- table counts, missing table notes, farm_workers rename, alert section updated |
| `02-tenant-isolation-rules.md` | FIXED -- Rule 7 status updated for all 6 services |
| `03-module-schemas-registry.md` | FIXED -- alert module status and alignment summary updated |
| `04-middleware-patterns.md` | FIXED -- broken implementations marked RESOLVED, status summary updated |
| `05-cron-job-patterns.md` | ACCURATE -- no changes needed (describes the problem and fix pattern) |
| `06-entity-guidelines.md` | FIXED -- Worker and audit_logs violation status updated |
| `07-migration-plan.md` | FIXED -- added C4 to completed items, updated summary counts, Phase 2.1 marked CODE COMPLETE |
| `08-audit-findings.md` | FIXED -- C1-C4 marked RESOLVED, H1/H5/H6 status updated, summary matrix updated |
| `09-frontend-data-flow.md` | ACCURATE -- no changes needed |
| `10-init-sql-reference.md` | ACCURATE -- no changes needed |
| `ALERT_ENGINE_SCHEMAS_NEEDED.md` | FIXED -- checklist updated to reflect MODULE_SCHEMAS entry and syncTenantSchema update |

---

## Missing Documents Check

| Document | Status |
|----------|--------|
| `07-migration-plan.md` | EXISTS -- comprehensive migration plan covering all phases |
| Auth/admin duplicate resolution doc | NOT SEPARATE DOC -- covered in `08-audit-findings.md` (H4) and `07-migration-plan.md` (Phase 3.1) |

---

## Recommendations

1. **Automate consistency checks.** The table counts and middleware status should be derived programmatically from the code rather than manually maintained in docs. Consider a CI script that extracts MODULE_SCHEMAS table counts and compares against doc claims.

2. **Single canonical table list.** Doc `03-module-schemas-registry.md` should be the ONLY document that lists individual table names. Other docs should reference it rather than duplicating the lists.

3. **Status tracking in one place.** The audit finding status is currently tracked in both `08-audit-findings.md` and `07-migration-plan.md`. Consider consolidating resolution status into `08-audit-findings.md` only, with `07-migration-plan.md` focusing on the "how" rather than the "what's done."
