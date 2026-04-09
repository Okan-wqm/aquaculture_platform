# HIGH-004 Validation: `getRepository()` Usage Bypasses Tenant Isolation

**Date:** 2026-04-09
**Agent:** auth-security-expert
**Scope:** Validate all claimed getRepository() call sites from orchestrator report

---

## Architecture Context

Three distinct tenant isolation layers protect data access:

1. **TenantConnectionBootstrap** (`libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`): Monkey-patches `pg.Pool.connect()` so every connection gets `SET search_path TO "tenant_xxx", <service>, public` when AsyncLocalStorage has tenant context.

2. **`queryRunner.manager.getRepository()`**: Uses pinned connection. If obtained within request context, inherits search_path from pool patch.

3. **`this.dataSource.getRepository()`**: Checks out fresh connection per query. Within request context, pool patch fires on checkout.

**Key distinction:** The `getRepository()` ban in CLAUDE.md concerns missing automatic `tenantId` WHERE clauses (which `getScopedRepository()` provides), NOT schema routing (handled by pool patch).

---

## Orchestrator Claimed Call Sites

### Sites #1-3: HR Create/Update Handlers

| File | Line | tenantId Filter | search_path | Verdict |
|------|------|----------------|-------------|---------|
| `hr-service/.../update-employee.handler.ts` | 28 | YES (line 31, 42) | YES (pool patch) | **FALSE POSITIVE** |
| `hr-service/.../create-department.handler.ts` | 24 | YES (line 28, 38, 46) | YES (pool patch) | **FALSE POSITIVE** |
| `hr-service/.../create-employee.handler.ts` | 27 | YES (line 31, 60, 114) | YES (pool patch) | **FALSE POSITIVE** |

### Sites #4-6: HR Performance Handlers (Orchestrator claimed "NO tenantId filter")

| File | Line | tenantId Filter | Orchestrator Claim | Verdict |
|------|------|----------------|-------------------|---------|
| `acknowledge-review.handler.ts` | 49 | **YES** `{ id: reviewId, tenantId }` | "NO tenantId filter" | **FALSE POSITIVE — Orchestrator hallucinated** |
| `update-goal.handler.ts` | 45 | **YES** `{ id, tenantId }` | "NO tenantId filter" | **FALSE POSITIVE — Orchestrator hallucinated** |
| `defer-goal.handler.ts` | 48 | **YES** `{ id: goalId, tenantId }` | "NO tenantId filter" | **FALSE POSITIVE — Orchestrator hallucinated** |

All three include `tenantId` in WHERE clause. However, they use `this.dataSource.getRepository()` (post-commit re-fetch on different connection) — consistency risk, not security risk.

### Site #7: farm-service feeding-scheduler.service.ts

**9 occurrences** (not 7): Lines 1158, 1215, 1299, 1303, 1355, 1411, 1442, 1483, 1487.

All within cron job code that EXPLICITLY sets `search_path` via `await queryRunner.query('SET search_path TO "${schema}", farm, public')` BEFORE `getRepository()` calls. Every call includes `tenantId` in WHERE clauses.

**Verdict: FALSE POSITIVE** — Architecturally correct cron-job pattern with manual search_path management.

### Site #8: sensor-service automation.service.ts

| Line | Context | tenantId | Verdict |
|------|---------|----------|---------|
| 133, 191, 688, 861, 2468 | Inside `withTenantSchema()` wrapper | YES | FALSE POSITIVE |
| **1669** | `loadIoConfigMap()` — NOT inside `withTenantSchema()` | **NO** (entity has no tenantId column) | **CONFIRMED WEAK** — relies on caller pre-filtering |

### Site #9: sensor-service edge-device.service.ts:1832

Inside `this.dataSource.transaction()` callback. CREATE operation scoped to device already tenant-validated upstream.

**Verdict: FALSE POSITIVE**

---

## Newly Discovered Findings

### AUTH-HIGH-001: MQTT handler writes DeviceEvent to wrong schema [HIGH]

**File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1246`

```typescript
this.dataSource.getRepository(DeviceEvent).save(events)
```

Called in MQTT handler context (no HTTP request, no AsyncLocalStorage). Pool patch defaults to `sensor, public` search_path. DeviceEvent.save() may write events to source schema instead of tenant schema.

### AUTH-HIGH-002: MQTT handler reads DeviceIoConfig without tenant scope [MEDIUM]

**File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1177`

```typescript
this.dataSource.getRepository(DeviceIoConfig).find({ where: { deviceId, isActive: true } })
```

No tenantId column on entity, no request context. Relies on deviceId indirect scoping.

### AUTH-HIGH-003: Systemic post-commit re-fetch pattern in 17 HR handlers [MEDIUM]

17 HR performance/training handlers use this pattern:
```typescript
// Transaction with queryRunner.manager.getRepository()
await queryRunner.commitTransaction();
// Re-fetch with this.dataSource.getRepository() — DIFFERENT connection
const result = await this.dataSource.getRepository(Entity).findOne({
  where: { id, tenantId }, relations: [...]
});
```

Not a tenant leak (tenantId present), but acquires different pool connection after commit. Fragile if read replicas added.

### AUTH-HIGH-004: String-based entity lookup in farm-service [LOW]

**File:** `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070, 1719, 1788`

Uses `this.dataSource.getRepository('SubEquipment')` with string names. tenantId present but no type checking.

---

## Overall Verdict

**PARTIALLY CONFIRMED with significant orchestrator inaccuracies.**

- Orchestrator claimed "NO tenantId filter" on 3 sites — **all three were wrong** (hallucinated)
- Orchestrator said "16+" sites — actual count is **100+** across 8 services
- Orchestrator **missed the most dangerous call sites** (MQTT handler)
- Most claimed sites are code style violations, not security vulnerabilities

### Corrected Severity:

| Category | Severity | Count |
|----------|----------|-------|
| MQTT handler schema-routing (AUTH-HIGH-001) | **HIGH** | 1 |
| MQTT handler indirect scoping (AUTH-HIGH-002) | MEDIUM | 1 |
| Post-commit re-fetch pattern (AUTH-HIGH-003) | MEDIUM | 17 |
| Code style violations (getRepository with tenantId) | LOW | 80+ |

### Summary Table

| # | File:Line | Orchestrator Claim | Verdict | Risk |
|---|-----------|-------------------|---------|------|
| 1 | hr/.../update-employee.handler.ts:28 | bypass | FALSE POSITIVE | LOW |
| 2 | hr/.../create-department.handler.ts:24 | bypass | FALSE POSITIVE | LOW |
| 3 | hr/.../create-employee.handler.ts:27 | bypass | FALSE POSITIVE | LOW |
| 4 | hr/.../acknowledge-review.handler.ts:49 | NO tenantId | **WRONG** (tenantId present) | MEDIUM (pattern) |
| 5 | hr/.../update-goal.handler.ts:45 | NO tenantId | **WRONG** (tenantId present) | MEDIUM (pattern) |
| 6 | hr/.../defer-goal.handler.ts:48 | NO tenantId | **WRONG** (tenantId present) | MEDIUM (pattern) |
| 7 | farm/.../feeding-scheduler.service.ts (9) | 7 bypass | FALSE POSITIVE | LOW |
| 8a | sensor/.../automation.service.ts (5 sites) | bypass | FALSE POSITIVE | LOW |
| 8b | sensor/.../automation.service.ts:1669 | bypass | CONFIRMED WEAK | MEDIUM |
| 9 | sensor/.../edge-device.service.ts:1832 | bypass | FALSE POSITIVE | LOW |
| NEW | sensor/.../mqtt-listener.service.ts:1246 | (missed) | **NEW — HIGH** | HIGH |
| NEW | sensor/.../mqtt-listener.service.ts:1177 | (missed) | **NEW — MEDIUM** | MEDIUM |
