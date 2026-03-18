> **UPDATE 2026-03-18:** All 6 issues in this document have been RESOLVED.
> See 18-final-review-report.md for the authoritative final status.

# Remaining Issues - Exact File:Line References

> **Date:** 2026-03-18
> **Source:** Chief Architect Verification Report (`11-verification-report.md`)

---

## CRITICAL Issues (Data Isolation Violations)

### ISSUE 1: AI Service Missing from MODULE_SCHEMAS

**Severity:** CRITICAL -- Cross-tenant data leak
**Impact:** All tenant AI data (conversations, configs, audit logs) shared in `ai` source schema

**Root cause:** No `ai` module entry exists in MODULE_SCHEMAS. The AI service has middleware and bootstrap correctly implemented, but tenant provisioning never creates AI tables in `tenant_xxx` schemas.

**Files to fix:**

| # | File | Line | Action |
|---|------|------|--------|
| 1 | `libs/backend-common/src/database/schema-manager.service.ts` | After line 269 | Add `ai` module entry to MODULE_SCHEMAS array |
| 2 | `libs/backend-common/src/database/schema-manager.service.ts` | Line 509 | Add `'ai'` to `createTenantSchema()` default modules |
| 3 | `libs/backend-common/src/database/schema-manager.service.ts` | Line 1416 | Add `'ai'` to `syncTenantSchema()` default modules |

**Required MODULE_SCHEMAS entry:**
```typescript
{
  moduleName: 'ai',
  sourceSchema: 'ai',
  referenceDataTables: [],
  tables: [
    'tool_execution_audit',
    'agent_conversations',
    'tenant_agent_configs',
  ],
},
```

**Entity files confirming table names:**
- `apps/ai-service/src/audit/tool-execution-audit.entity.ts:9` -- `@Entity('tool_execution_audit')`
- `apps/ai-service/src/conversation/conversation.entity.ts:10` -- `@Entity('agent_conversations')`
- `apps/ai-service/src/tenant-config/agent-config.entity.ts:13` -- `@Entity('tenant_agent_configs')`

---

### ISSUE 2: auto-rule-trigger.service.ts -- processScheduleRules() has no tenant iteration

**Severity:** CRITICAL -- Cron hits source schema only
**Impact:** Schedule-type auto rules in tenant schemas are never evaluated

**File:** `apps/farm-service/src/task/services/auto-rule-trigger.service.ts`
**Line:** 187-227

**Problem:** Uses `this.autoRuleRepository.find()` at line 191 without any search_path or tenant schema iteration. The query hits `farm.auto_rules` (source schema), which is typically empty for correctly provisioned tenants. Tenant auto rules are invisible.

**Fix:** Rewrite to use QueryRunner pattern with `SET search_path` per tenant, same as `cron-jobs.service.ts` and `task.service.ts` were fixed.

---

### ISSUE 3: feeding-scheduler.service.ts -- All 6 cron methods bypass tenant schemas

**Severity:** CRITICAL -- Cron hits source schema only
**Impact:** Daily feeding plans, reminders, summaries, FCR analysis, stock checks, and forecasts all non-operational for tenant data

**File:** `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`

| Method | Line | Uses Repo | Repo Line |
|--------|------|-----------|-----------|
| `generateDailyFeedingPlan` | 732 | `this.feedingTableRepository.find()` via `generateTenantFeedingPlan()` | 981 |
| `sendFeedingReminders` | 762 | `this.getUpcomingFeedings()` | 353 |
| `dailyFeedingSummary` | 803 | Helper methods with injected repos | various |
| `analyzeFCR` | 842 | `this.checkFCRAlerts()` | 1101 |
| `checkFeedStock` | 887 | `this.getLowStockFeeds()` | 1150 |
| `weeklyFeedForecast` | 937 | Helper methods with injected repos | various |

**Problem:** All 6 methods iterate tenants (via `this.getActiveTenants()`), but call helper methods that use `@InjectRepository` repos directly. These repos use the default pool connection which has no search_path set in cron context (no HTTP request, no AsyncLocalStorage).

**Fix:** Each helper method must accept a `QueryRunner` parameter and use `queryRunner.manager` instead of injected repositories. OR wrap each tenant iteration in a QueryRunner with `SET search_path`.

---

### ISSUE 4: weather-cron.service.ts -- Both cron methods bypass tenant schemas

**Severity:** CRITICAL -- Cron hits source schema only
**Impact:** Weather data sync and cleanup run against empty source schema tables

**File:** `apps/farm-service/src/weather/services/weather-cron.service.ts`

| Method | Line | Problem |
|--------|------|---------|
| `syncWeatherData` | 26 | Uses `this.settingsRepo.find()` at line 36 without search_path |
| `cleanupOldData` | 89 | Uses `this.syncService.cleanupOldData()` at line 96 without search_path |

**Fix:** Add QueryRunner pattern with tenant schema iteration.

---

### ISSUE 5: hr-service leave-accrual.service.ts -- Both cron methods lack search_path

**Severity:** CRITICAL -- Cron hits source schema only
**Impact:** Leave accrual and yearly reset never process tenant data

**File:** `apps/hr-service/src/leave/leave-accrual.service.ts`

| Method | Line | Problem |
|--------|------|---------|
| `processMonthlyAccrual` | 38 | Uses `this.leaveTypeRepository.createQueryBuilder()` at line 45 to discover tenants (hits source schema). Then `processTenantAccrual()` at line 83 creates a QueryRunner but NEVER calls `SET search_path`. |
| `processYearlyReset` | 233 | Same pattern. QueryRunner at line 280 without search_path. |

**Fix:** Add `SET search_path TO "${schemaName}", hr, public` before `startTransaction()` in both `processTenantAccrual()` (after line 84) and the yearly reset method (after line 281).

---

### ISSUE 6: hr-service certification-expiry.service.ts -- No tenant iteration at all

**Severity:** CRITICAL -- Cron hits source schema only, no tenant awareness
**Impact:** Expired certifications in tenant schemas are never processed

**File:** `apps/hr-service/src/training/certification-expiry.service.ts`
**Line:** 35-83

**Problem:** `processExpiredCertifications()` uses `this.certRepository.find()` at line 42. There is:
1. No tenant schema discovery
2. No QueryRunner
3. No search_path
4. No tenant iteration

The query hits `hr.employee_certifications` (source schema) directly. If that table is empty (normal), zero certifications are ever processed.

**Fix:** Complete rewrite with QueryRunner + tenant schema iteration pattern.

---

## Documentation-vs-Reality Discrepancies

### DOC ISSUE 1: docs/db/04-middleware-patterns.md "BROKEN Implementations" section is stale

**File:** `docs/db/04-middleware-patterns.md`
**Lines:** 183-287

The document still lists sensor-service and hr-service as "BROKEN" with silent fallback. These have been FIXED. The "Service Status Summary" table at line 280 is now incorrect:
- sensor: Listed as `BROKEN` -- should be `CORRECT`
- hr: Listed as `BROKEN` -- should be `CORRECT`
- alert-engine: Listed as `NO middleware` -- should be `CORRECT`

### DOC ISSUE 2: docs/db/ALERT_ENGINE_SCHEMAS_NEEDED.md checklist is stale

**File:** `docs/db/ALERT_ENGINE_SCHEMAS_NEEDED.md`
**Line:** 50-51

The checklist shows:
- `[ ] MODULE_SCHEMAS entry added` -- This IS now done (MODULE_SCHEMAS has alert entry)
- `[ ] syncTenantSchema default modules updated` -- This IS now done

Both should be checked off.

### DOC ISSUE 3: docs/db/00-architecture-overview.md missing AI module

**File:** `docs/db/00-architecture-overview.md`
**Lines:** 22-24

Tier 2 source schemas table lists only farm (67), sensor (31), hr (24), hydroponics (1). Missing: alert (5) and ai (3).

### DOC ISSUE 4: docs/db/03-module-schemas-registry.md missing AI section

**File:** `docs/db/03-module-schemas-registry.md`
**Lines:** 247-257

The "Entity-to-Registry Alignment Summary" table shows alert as "NOT REGISTERED" -- it IS now registered. And AI is not mentioned at all.

---

## Summary

| # | Severity | Service | Issue | Est. Fix Effort |
|---|----------|---------|-------|-----------------|
| 1 | CRITICAL | ai-service | No MODULE_SCHEMAS entry (3 tables) | 30 min |
| 2 | CRITICAL | farm-service | `auto-rule-trigger.service.ts:187` -- no tenant iteration | 2 hours |
| 3 | CRITICAL | farm-service | `feeding-scheduler.service.ts` -- 6 cron methods | 4 hours |
| 4 | CRITICAL | farm-service | `weather-cron.service.ts` -- 2 cron methods | 2 hours |
| 5 | CRITICAL | hr-service | `leave-accrual.service.ts` -- 2 cron methods | 2 hours |
| 6 | CRITICAL | hr-service | `certification-expiry.service.ts` -- 1 cron method | 2 hours |
| - | LOW | docs | 4 documentation files stale | 1 hour |

**Total estimated fix effort: ~12 hours**

**Priority order:**
1. **ISSUE 1** (AI MODULE_SCHEMAS) -- 30-minute fix, prevents active data leak
2. **ISSUE 5** (HR leave accrual) -- Already has QueryRunner, just needs one line added
3. **ISSUE 6** (HR certification expiry) -- Small service, full rewrite needed
4. **ISSUE 2** (auto-rule-trigger) -- Small method, straightforward
5. **ISSUE 4** (weather cron) -- Two methods, moderate
6. **ISSUE 3** (feeding-scheduler) -- Largest scope, 6 methods + helper refactoring
